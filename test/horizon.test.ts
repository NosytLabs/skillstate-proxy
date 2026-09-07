/**
 * Long-horizon usefulness: Σ keeps planted facts, prompts stay bounded,
 * and a fact never patched into Σ is gone (not a 200k-token transcript).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, Server, IncomingMessage } from "node:http";
import { startProxy } from "../src/proxy.js";
import { applyDelta, mergeState, newSession } from "../src/state.js";
import { rmSync } from "node:fs";

const NEEDLE = "NEEDLE-7f3a";
const N = 50;

interface MockCall { body: any }
let mockCalls: MockCall[] = [];
let mockServer: Server | null = null;
let mockPort = 0;

function startMock() {
  return new Promise<Server>((resolve) => {
    const s = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        let body: any = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf-8")); } catch { /* */ }
        mockCalls.push({ body });
        const step = mockCalls.length;
        const sources = Array.from({ length: step }, (_, i) =>
          i === 0 ? NEEDLE : `src-${i + 1}`,
        );
        const content =
          "```json\n" +
          JSON.stringify({
            state_patch: { step, claim_id: NEEDLE, sources, notes: `turn ${step}` },
            action: "continue",
          }) +
          "\n```";
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          id: "h", object: "chat.completion", model: "mock",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 120 + step, completion_tokens: 40 },
        }));
      });
    });
    s.listen(0, "127.0.0.1", () => {
      mockPort = (s.address() as any).port;
      resolve(s);
    });
  });
}

describe("long-horizon research loop", () => {
  let proxy: Awaited<ReturnType<typeof startProxy>>;
  const dir = "/tmp/ss-horizon-" + Date.now();

  beforeAll(async () => {
    mockServer = await startMock();
    proxy = await startProxy({
      listenPort: 0,
      upstreams: [{ name: "mock", url: `http://127.0.0.1:${mockPort}/v1`, apiKey: "x", priority: 0 }],
      stateDir: dir,
      schema: ["step", "claim_id", "sources", "notes"],
      initialState: { step: 0, claim_id: "", sources: [], notes: "" },
      maxRetries: 0,
    });
  });

  afterAll(() => {
    proxy?.close();
    mockServer?.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  });

  it(`keeps a planted needle in Σ after ${N} steps; upstream never sees the full transcript`, async () => {
    mockCalls = [];
    const sid = "research-1";
    for (let i = 0; i < N; i++) {
      const r = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-skillstate-session": sid },
        body: JSON.stringify({
          model: "mock",
          messages: [
            { role: "system", content: "Research agent. Patch claim_id, sources (FULL list), notes." },
            { role: "user", content: i === 0
              ? `Start. Secret claim_id is ${NEEDLE}. Store it in state.`
              : `Observation ${i + 1}: found source src-${i + 1}. Keep claim_id.` },
          ],
        }),
      });
      expect(r.status).toBe(200);
    }

    const st = await fetch(`http://127.0.0.1:${proxy.port}/state?session=${sid}`).then((r) => r.json());
    expect(st.state.claim_id).toBe(NEEDLE);
    expect(st.state.sources).toContain(NEEDLE);
    expect(st.state.sources).toHaveLength(N);
    expect(st.state.step).toBe(N);

    // Every upstream prompt is (P, Σ, O) — not 25 user turns.
    for (const c of mockCalls) {
      const msgs = c.body.messages ?? [];
      expect(msgs.length).toBe(2);
      const blob = JSON.stringify(msgs);
      const userTurns = (blob.match(/Observation /g) ?? []).length;
      expect(userTurns).toBeLessThanOrEqual(1);
    }
  });

  it("a fact never written to Σ is gone next turn (not a 200k transcript)", () => {
    const s = newSession("P", { claim_id: "", notes: "" }, ["claim_id", "notes"]);
    applyDelta(s, { notes: "saw a cat" });
    // next patch overwrites notes, never stored claim
    applyDelta(s, { notes: "saw a dog" });
    expect(s.state.notes).toBe("saw a dog");
    expect(s.state.claim_id).toBe("");
    expect(JSON.stringify(s.state)).not.toContain("cat");
  });

  it("array patches REPLACE (resend the full list or you lose items)", () => {
    const r = mergeState({ sources: ["a", "b"] }, { sources: ["c"] });
    expect(r.sources).toEqual(["c"]);
  });
});
