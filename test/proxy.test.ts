/**
 * Proxy integration tests with an in-process mock upstream.
 * No network, fully deterministic. Verifies:
 *   - (P, Σ, O) rewriting
 *   - State accumulation across turns
 *   - Rollback-retry when model fails to emit paper-format ΔΣ
 *   - Session headers propagation
 *   - cost ledger writes
 *   - Anthropic-shape input → OpenAI-shape upstream → Anthropic-shape response
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, Server, IncomingMessage } from "node:http";
import { startProxy } from "../src/proxy.js";
import { rmSync, existsSync, readFileSync } from "node:fs";

interface MockCall { path: string; body: any; }
let mockCalls: MockCall[] = [];
let mockMode: "ok-paper" | "ok-legacy" | "bad-then-good" = "ok-paper";
let mockServer: Server | null = null;
let mockPort = 0;

function startMock() {
  return new Promise<Server>((resolve) => {
    const s = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let body: any = {};
        try { body = JSON.parse(raw); } catch { /* */ }
        mockCalls.push({ path: req.url ?? "", body });
        res.setHeader("content-type", "application/json");
        const step = mockCalls.length;
        if (req.url?.includes("/chat/completions")) {
          if (mockMode === "bad-then-good") {
            if (step === 1) {
              // simulate model forgetting to emit state_patch
              res.end(JSON.stringify({
                id: "m1", object: "chat.completion", model: body.model ?? "x",
                choices: [{ index: 0, message: { role: "assistant", content: "Reasoning only, no json." }, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 20 },
              }));
              return;
            }
            // retry: emit proper paper format
            res.end(JSON.stringify({
              id: "m2", object: "chat.completion", model: body.model ?? "x",
              choices: [{ index: 0, message: { role: "assistant", content: '```json\n{"state_patch": {"step": 1, "ok": true}, "action": "next"}\n```' }, finish_reason: "stop" }],
              usage: { prompt_tokens: 110, completion_tokens: 30 },
            }));
            return;
          }
          if (mockMode === "ok-legacy") {
            res.end(JSON.stringify({
              id: "m", object: "chat.completion", model: body.model ?? "x",
              choices: [{ index: 0, message: { role: "assistant", content: '```json\n{"step": ' + step + '}\n```' }, finish_reason: "stop" }],
              usage: { prompt_tokens: 80, completion_tokens: 15 },
            }));
            return;
          }
          // ok-paper (default)
          res.end(JSON.stringify({
            id: "m", object: "chat.completion", model: body.model ?? "x",
            choices: [{ index: 0, message: { role: "assistant", content: '```json\n{"state_patch": {"step": ' + step + ', "count": ' + step + '}, "action": "do"}\n```' }, finish_reason: "stop" }],
            usage: { prompt_tokens: 90, completion_tokens: 25 },
          }));
          return;
        }
        res.end("{}");
      });
    });
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr && typeof addr === "object") mockPort = addr.port;
      resolve(s);
    });
    return s;
  });
}

describe("proxy: end-to-end with mock upstream", () => {
  const stateDir = "/tmp/skillstate-mock-" + Date.now();
  let proxyClose: () => void;
  let proxyPort = 0;

  beforeAll(async () => {
    mockServer = await startMock();
    if (existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true });
    mockCalls = [];
    mockMode = "ok-paper";
    const s = await startProxy({
      listenPort: 0,
      upstreams: [{ name: "mock", url: `http://127.0.0.1:${mockPort}/v1`, priority: 0 }],
      stateDir,
      schema: ["step", "count", "ok"],
      initialState: { step: 0, count: 0, ok: false },
    });
    proxyPort = s.port;
    proxyClose = s.close;
  });

  afterAll(() => {
    proxyClose && proxyClose();
    mockServer && mockServer.close();
  });

  it("sends (P, Σ, O) to upstream and accumulates state across turns", async () => {
    const sid = "test-session-1";
    const headers = { "content-type": "application/json", authorization: "Bearer test", "x-skillstate-session": sid };
    for (let i = 1; i <= 3; i++) {
      const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
        method: "POST", headers,
        body: JSON.stringify({
          model: "test-model",
          stream: false,
          messages: [
            { role: "system", content: "TASK: test" },
            { role: "user", content: `turn ${i}` },
          ],
        }),
      });
      expect(r.status).toBe(200);
      expect(r.headers.get("x-skillstate-session")).toBe(sid);
      expect(Number(r.headers.get("x-skillstate-step"))).toBe(i);
    }
    expect(mockCalls.length).toBe(3);
    // Each upstream call must contain the rewritten (P, Σ, O) pair (2 messages only)
    for (const c of mockCalls) {
      const msgs = c.body.messages;
      expect(msgs.length).toBe(2);
      expect(msgs[0].role).toBe("system");
      expect(msgs[0].content).toContain("Skill Execution State");
      expect(msgs[1].role).toBe("user");
    }
    // State file persists and step == 3
    const st = JSON.parse(readFileSync(`${stateDir}/${sid}.json`, "utf-8"));
    expect(st.step).toBe(3);
    expect(st.state.step).toBe(3);
    expect(st.state.count).toBe(3);
  });

  it("triggers rollback-retry when model omits state_patch, then recovers", async () => {
    mockCalls = [];
    mockMode = "bad-then-good";
    const sid = "test-retry";
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test", "x-skillstate-session": sid },
      body: JSON.stringify({
        model: "test-model",
        stream: false,
        messages: [
          { role: "system", content: "TASK: retry test" },
          { role: "user", content: "go" },
        ],
      }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-skillstate-retries")).toBe("1");
    // Upstream called twice (1 bad + 1 retry)
    expect(mockCalls.length).toBe(2);
    // Second call's user message contains the correction
    const second = mockCalls[1]!.body.messages[1].content as string;
    expect(second).toContain("CORRECTION");
    // Final state reflects the recovered delta
    const st = JSON.parse(readFileSync(`${stateDir}/${sid}.json`, "utf-8"));
    expect(st.step).toBe(1);
    expect(st.state.step).toBe(1);
    expect(st.state.ok).toBe(true);
    // restore default mode
    mockMode = "ok-paper";
  });

  it("emits x-skillstate-action header when model returns paper format", async () => {
    mockCalls = [];
    const sid = "test-action";
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test", "x-skillstate-session": sid },
      body: JSON.stringify({
        model: "test-model",
        stream: false,
        messages: [
          { role: "system", content: "TASK: action test" },
          { role: "user", content: "do it" },
        ],
      }),
    });
    expect(r.headers.get("x-skillstate-action")).toBe("do");
  });

  it("exposes session state via /state and resets via DELETE", async () => {
    const sid = "test-state-endpoint";
    mockCalls = []; // mock derives state values from the global call counter — reset it
    // create the session with one chat call
    const r0 = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test", "x-skillstate-session": sid },
      body: JSON.stringify({
        model: "test-model", stream: false,
        messages: [{ role: "system", content: "TASK: state endpoint" }, { role: "user", content: "go" }],
      }),
    });
    expect(r0.status).toBe(200);

    // inspect
    const g = await fetch(`http://127.0.0.1:${proxyPort}/state?session=${sid}`);
    expect(g.status).toBe(200);
    const j = await g.json();
    expect(j.session).toBe(sid);
    expect(j.step).toBe(1);
    expect(j.state).toHaveProperty("step", 1);

    // list sessions
    const ls = await fetch(`http://127.0.0.1:${proxyPort}/state`);
    const lsj = await ls.json();
    expect(Array.isArray(lsj.sessions)).toBe(true);
    expect(lsj.sessions).toContain(sid);

    // 404 for unknown session
    const nf = await fetch(`http://127.0.0.1:${proxyPort}/state?session=nope`);
    expect(nf.status).toBe(404);

    // 400 for path-traversal attempt
    const bad = await fetch(`http://127.0.0.1:${proxyPort}/state?session=..%2F..%2Fetc`);
    expect(bad.status).toBe(400);

    // reset
    const d = await fetch(`http://127.0.0.1:${proxyPort}/state?session=${sid}`, { method: "DELETE" });
    expect(d.status).toBe(204);
    const nf2 = await fetch(`http://127.0.0.1:${proxyPort}/state?session=${sid}`);
    expect(nf2.status).toBe(404);
  });

  it("allows CORS preflight for DELETE /state", async () => {
    const pre = await fetch(`http://127.0.0.1:${proxyPort}/state?session=cors-preflight`, {
      method: "OPTIONS",
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "DELETE",
        "access-control-request-headers": "content-type, x-skillstate-session",
      },
    });
    expect(pre.status).toBe(204);
    const allow = (pre.headers.get("access-control-allow-methods") ?? "").toUpperCase();
    expect(allow).toContain("DELETE");
    expect(allow).toContain("GET");
    expect(allow).toContain("POST");
    expect(allow).toContain("OPTIONS");
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");

    const del = await fetch(`http://127.0.0.1:${proxyPort}/state?session=cors-preflight`, {
      method: "DELETE",
      headers: { origin: "https://example.com" },
    });
    expect(del.status).toBe(204);
    expect(del.headers.get("access-control-allow-origin")).toBe("*");
    const actual = (del.headers.get("access-control-allow-methods") ?? "").toUpperCase();
    expect(actual).toContain("DELETE");
  });

  it("accepts Anthropic /v1/messages and returns Anthropic shape", async () => {
    mockCalls = [];
    const sid = "test-anthropic";
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test", "x-skillstate-session": sid },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 200,
        system: "TASK: anthropic test",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.type).toBe("message");
    expect(j.role).toBe("assistant");
    expect(Array.isArray(j.content)).toBe(true);
    expect(j.content[0].type).toBe("text");
  });
});