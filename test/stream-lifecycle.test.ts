import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy } from "../src/proxy.js";

const servers: Server[] = [];
const dirs: string[] = [];
function dir() { const d = mkdtempSync(join(tmpdir(), "ss-stream-life-")); dirs.push(d); return d; }
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function hangingUpstream() {
  let closed!: () => void;
  const closedPromise = new Promise<void>(resolve => { closed = resolve; });
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.setHeader("content-type", "text/event-stream");
    res.on("close", closed);
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as any).port}/v1`, closedPromise };
}

async function streamRequest(port: number, signal?: AbortSignal) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", signal,
    headers: { "content-type": "application/json", "x-skillstate-session": "life" },
    body: JSON.stringify({ model: "test", stream: true, messages: [{ role: "system", content: "spec" }, { role: "user", content: "go" }] }),
  });
}

describe("stream lifecycle", () => {
  it("cancels a hanging upstream body at the whole-request deadline", async () => {
    const up = await hangingUpstream();
    const proxy = await startProxy({
      listenPort: 0, stateDir: dir(), upstreams: [{ name: "up", url: up.url, priority: 0 }],
      connectTimeoutMs: 500, requestTimeoutMs: 100, retryMaxAttempts: 1,
    });
    const response = await streamRequest(proxy.port);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("first");
    const closed = await Promise.race([
      up.closedPromise.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 600)),
    ]);
    expect(closed).toBe(true);
    proxy.close();
  });

  it("cancels the upstream body when the downstream client aborts", async () => {
    const up = await hangingUpstream();
    const proxy = await startProxy({
      listenPort: 0, stateDir: dir(), upstreams: [{ name: "up", url: up.url, priority: 0 }],
      connectTimeoutMs: 500, requestTimeoutMs: 5000, retryMaxAttempts: 1,
    });
    const controller = new AbortController();
    const response = await streamRequest(proxy.port, controller.signal);
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    const closed = await Promise.race([
      up.closedPromise.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 600)),
    ]);
    expect(closed).toBe(true);
    proxy.close();
  });
});
