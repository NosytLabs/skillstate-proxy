import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { requestUpstream, TransportError } from "../src/transport.js";

const servers: Server[] = [];
async function mock(handler: Parameters<typeof createServer>[0]): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return { url: `http://127.0.0.1:${addr.port}/v1`, server };
}
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

function controls(upstreams: any[]) {
  return {
    limiters: new Map(upstreams.map(u => [u.name, new RateLimiter(u)])),
    breakers: new Map(upstreams.map(u => [u.name, new CircuitBreaker(u.name, { failureThreshold: 2, openCooldownMs: 50 })])),
  };
}

async function run(upstreams: any[], extra: any = {}) {
  const ctl = controls(upstreams);
  return requestUpstream({
    upstreams,
    path: "/v1/chat/completions",
    method: "POST",
    body: "{}",
    incomingHeaders: { "content-type": "application/json" },
    estimatedTokens: 10,
    ...ctl,
    connectTimeoutMs: 1000,
    requestTimeoutMs: 2000,
    retryMaxAttempts: 2,
    retryAfterCapMs: 10,
    ...extra,
  });
}

describe("requestUpstream", () => {
  it("skips a locally rate-limited upstream and uses the next one", async () => {
    let firstCalls = 0, secondCalls = 0;
    const first = await mock((_req, res) => { firstCalls++; res.end("first"); });
    const second = await mock((_req, res) => { secondCalls++; res.end("second"); });
    const upstreams = [
      { name: "one", url: first.url, priority: 0, rpm: 1 },
      { name: "two", url: second.url, priority: 1 },
    ];
    const ctl = controls(upstreams);
    ctl.limiters.get("one")!.record(1);
    const selected = await requestUpstream({
      upstreams, path: "/v1/chat/completions", method: "POST", body: "{}",
      incomingHeaders: {}, estimatedTokens: 1, ...ctl,
      connectTimeoutMs: 1000, requestTimeoutMs: 2000, retryMaxAttempts: 1, retryAfterCapMs: 10,
    });
    expect(selected.upstream.name).toBe("two");
    expect(firstCalls).toBe(0);
    expect(secondCalls).toBe(1);
    selected.finish();
  });

  it("retries a retryable 500 before succeeding", async () => {
    let calls = 0;
    const m = await mock((_req, res) => {
      calls++;
      if (calls === 1) { res.statusCode = 500; res.end("bad"); return; }
      res.setHeader("content-type", "application/json"); res.end('{"ok":true}');
    });
    const selected = await run([{ name: "one", url: m.url, priority: 0 }]);
    expect(calls).toBe(2);
    expect(selected.response.status).toBe(200);
    expect(selected.attempts.filter(a => a.upstream === "one")).toHaveLength(2);
    selected.finish();
  });

  it("fails over on 401 to another upstream with its own credentials", async () => {
    let auth = "";
    const first = await mock((_req, res) => { res.statusCode = 401; res.end("no"); });
    const second = await mock((req, res) => { auth = String(req.headers.authorization ?? ""); res.end("ok"); });
    const selected = await run([
      { name: "one", url: first.url, apiKey: "bad", priority: 0 },
      { name: "two", url: second.url, apiKey: "good", priority: 1 },
    ]);
    expect(selected.upstream.name).toBe("two");
    expect(auth).toBe("Bearer good");
    selected.finish();
  });

  it("caps Retry-After instead of waiting an unbounded time", async () => {
    let calls = 0;
    const m = await mock((_req, res) => {
      calls++;
      if (calls === 1) { res.statusCode = 429; res.setHeader("retry-after", "60"); res.end("later"); return; }
      res.end("ok");
    });
    const started = Date.now();
    const selected = await run([{ name: "one", url: m.url, priority: 0 }], { retryAfterCapMs: 10 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(calls).toBe(2);
    selected.finish();
  });

  it("records accepted attempts in the limiter before sending", async () => {
    const m = await mock((_req, res) => { res.statusCode = 500; res.end("bad"); });
    const upstreams = [{ name: "one", url: m.url, priority: 0, rpm: 1 }];
    const ctl = controls(upstreams);
    await expect(requestUpstream({
      upstreams, path: "/v1/chat/completions", method: "POST", body: "{}", incomingHeaders: {}, estimatedTokens: 1,
      ...ctl, connectTimeoutMs: 1000, requestTimeoutMs: 2000, retryMaxAttempts: 2, retryAfterCapMs: 10,
    })).rejects.toBeInstanceOf(TransportError);
    expect(ctl.limiters.get("one")!.check(1).ok).toBe(false);
  });
});
