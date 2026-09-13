import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy } from "../src/proxy.js";

const servers: Server[] = [];
const dirs: string[] = [];

async function mock(handler: (req: IncomingMessage, res: any, body: any) => void | Promise<void>) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: any = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* ignored */ }
    await handler(req, res, body);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("mock did not bind");
  return `http://127.0.0.1:${addr.port}/v1`;
}

function stateDir() {
  const d = mkdtempSync(join(tmpdir(), "skillstate-proxy-hardening-"));
  dirs.push(d);
  return d;
}

async function post(port: number, body: any, session?: string) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(session ? { "x-skillstate-session": session } : {}),
    },
    body: JSON.stringify(body),
  });
}

function completion(content: string, extra: any = {}) {
  return JSON.stringify({
    id: "m", object: "chat.completion", model: "test",
    choices: [{ index: 0, message: { role: "assistant", content, ...(extra.message ?? {}) }, finish_reason: extra.finish_reason ?? "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve()))));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("hardened proxy integration", () => {
  it("creates independent random sessions when no session header is supplied", async () => {
    const upstream = await mock((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(completion('```json\n{"state_patch":{"n":1},"action":"next"}\n```'));
    });
    const proxy = await startProxy({ listenPort: 0, upstreams: [{ name: "mock", url: upstream, priority: 0 }], stateDir: stateDir(), initialState: { n: 0 }, schema: ["n"] });
    const body = { model: "test", messages: [{ role: "system", content: "same spec" }, { role: "user", content: "go" }] };
    const a = await post(proxy.port, body);
    const b = await post(proxy.port, body);
    const sidA = a.headers.get("x-skillstate-session");
    const sidB = b.headers.get("x-skillstate-session");
    expect(sidA).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sidB).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sidA).not.toBe(sidB);
    proxy.close();
  });

  it("exposes session headers through CORS", async () => {
    const upstream = await mock((_req, res) => res.end(completion('```json\n{"state_patch":{},"action":"next"}\n```')));
    const proxy = await startProxy({ listenPort: 0, upstreams: [{ name: "mock", url: upstream, priority: 0 }], stateDir: stateDir() });
    const r = await post(proxy.port, { model: "test", messages: [{ role: "system", content: "spec" }, { role: "user", content: "go" }] });
    const exposed = (r.headers.get("access-control-expose-headers") ?? "").toLowerCase();
    expect(exposed).toContain("x-skillstate-session");
    expect(exposed).toContain("x-skillstate-step");
    proxy.close();
  });

  it("leaves state and step unchanged when a strict transition is invalid", async () => {
    const upstream = await mock((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(completion('```json\n{"state_patch":{"n":"wrong-type"},"action":"next"}\n```'));
    });
    const proxy = await startProxy({
      listenPort: 0,
      upstreams: [{ name: "mock", url: upstream, priority: 0 }],
      stateDir: stateDir(), initialState: { n: 0 }, schema: ["n"], maxRetries: 0,
    });
    const sid = "invalid-transition";
    const r = await post(proxy.port, { model: "test", messages: [{ role: "system", content: "spec" }, { role: "user", content: "go" }] }, sid);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-skillstate-transition")).toBe("invalid");
    const state = await fetch(`http://127.0.0.1:${proxy.port}/state?session=${sid}`).then(x => x.json());
    expect(state.step).toBe(0);
    expect(state.state).toEqual({ n: 0 });
    proxy.close();
  });

  it("keeps the entire parallel tool-result batch in the next O_t", async () => {
    const calls: any[] = [];
    const upstream = await mock((_req, res, body) => {
      calls.push(body);
      res.setHeader("content-type", "application/json");
      if (calls.length === 1) {
        res.end(completion("", {
          finish_reason: "tool_calls",
          message: { tool_calls: [
            { id: "call_1", type: "function", function: { name: "a", arguments: "{}" } },
            { id: "call_2", type: "function", function: { name: "b", arguments: "{}" } },
          ] },
        }));
        return;
      }
      res.end(completion('```json\n{"state_patch":{"done":true},"action":"finish"}\n```'));
    });
    const proxy = await startProxy({ listenPort: 0, upstreams: [{ name: "mock", url: upstream, priority: 0 }], stateDir: stateDir(), initialState: { done: false }, schema: ["done"] });
    const sid = "parallel-tools";
    const tools = [
      { type: "function", function: { name: "a", parameters: { type: "object" } } },
      { type: "function", function: { name: "b", parameters: { type: "object" } } },
    ];
    const first = await post(proxy.port, { model: "test", tools, messages: [{ role: "system", content: "spec" }, { role: "user", content: "run" }] }, sid);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-skillstate-step")).toBe("1");
    const firstJson: any = await first.json();
    await post(proxy.port, {
      model: "test", tools,
      messages: [
        { role: "system", content: "spec" },
        { role: "assistant", content: "", tool_calls: firstJson.choices[0].message.tool_calls },
        { role: "tool", tool_call_id: "call_1", name: "a", content: "RESULT-A" },
        { role: "tool", tool_call_id: "call_2", name: "b", content: "RESULT-B" },
      ],
    }, sid);
    const observation = String(calls[1].messages[1].content);
    expect(observation).toContain("call_1");
    expect(observation).toContain("RESULT-A");
    expect(observation).toContain("call_2");
    expect(observation).toContain("RESULT-B");
    proxy.close();
  });

  it("forwards the first SSE chunk before the upstream finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const upstream = await mock(async (_req, res, body) => {
      if (!body.stream) throw new Error("expected stream");
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
      await gate;
      res.write('data: {"choices":[{"delta":{"content":" second"}}]}\n\n');
      res.end("data: [DONE]\n\n");
    });
    const proxy = await startProxy({ listenPort: 0, upstreams: [{ name: "mock", url: upstream, priority: 0 }], stateDir: stateDir() });
    const responsePromise = post(proxy.port, {
      model: "test", stream: true,
      messages: [{ role: "system", content: "spec" }, { role: "user", content: "go" }],
    }, "stream-session");
    const firstArrived = await Promise.race([
      responsePromise.then(async r => {
        const reader = r.body!.getReader();
        const chunk = await reader.read();
        return !chunk.done && new TextDecoder().decode(chunk.value).includes("first");
      }),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 250)),
    ]);
    release();
    expect(firstArrived).toBe(true);
    proxy.close();
  });
});
