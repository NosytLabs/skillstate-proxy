import { afterAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { requestUpstream } from "../src/transport.js";

let server: ReturnType<typeof createServer>;

describe("transport retry usage", () => {
  afterAll(() => server?.close());

  it("captures token usage from a retryable failed generation", async () => {
    let calls = 0;
    server = createServer((_req, res) => {
      calls++;
      res.setHeader("content-type", "application/json");
      if (calls === 1) {
        res.statusCode = 500;
        res.end(JSON.stringify({ model: "m", error: "retry", usage: { prompt_tokens: 21, completion_tokens: 4 } }));
        return;
      }
      res.end(JSON.stringify({ model: "m", ok: true, usage: { prompt_tokens: 22, completion_tokens: 5 } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    const upstream = { name: "one", url: `http://127.0.0.1:${port}/v1`, priority: 0 };
    const selected = await requestUpstream({
      upstreams: [upstream], path: "/v1/chat/completions", method: "POST", body: "{}",
      incomingHeaders: {}, estimatedTokens: 1,
      limiters: new Map([["one", new RateLimiter(upstream)]]),
      breakers: new Map([["one", new CircuitBreaker("one")]]),
      connectTimeoutMs: 1000, requestTimeoutMs: 2000, retryMaxAttempts: 2, retryAfterCapMs: 5,
    });
    expect(selected.attempts[0].status).toBe(500);
    expect(selected.attempts[0].model).toBe("m");
    expect(selected.attempts[0].inputTokens).toBe(21);
    expect(selected.attempts[0].outputTokens).toBe(4);
    selected.finish();
  });
});
