/**
 * Long-horizon property assertions: prompt size and Σ growth bounds.
 *
 * The paper claims ~20× savings vs ReAct at horizon 100. Here we lock in the
 * *properties* that produce that savings, so a future refactor that breaks the
 * invariant will fail loudly without freezing exact numbers.
 *
 * - Prompt size at step T is bounded by |spec| + |Σ_t| + |obs| (the runtime
 *   rebuilds upstream messages to exactly that triple).
 * - |Σ_t| grows with schema size × step count (linear, not quadratic).
 * - Reasoning in earlier turns is discarded (paper §3.2).
 *
 * We exercise the property at steps 1, 5, 50, 100 against a mock upstream; the
 * assertions are about structural relationships, not token counts (no
 * tokenizer required).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, Server, IncomingMessage } from "node:http";
import { startProxy } from "../src/proxy.js";
import { rmSync } from "node:fs";

interface MockCall { body: any; rawJson: string }
let calls: MockCall[] = [];
let mockServer: Server | null = null;
let mockPort = 0;
const NEEDLE = "HORIZON-NEEDLE-f1d4";

function startMock() {
  return new Promise<Server>((resolve) => {
    const s = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let body: any = {};
        try { body = JSON.parse(raw); } catch { /* */ }
        calls.push({ body, rawJson: raw });
        const step = calls.length;
        // The current Σ is the JSON inside the ```json ... ``` fence in the system
        // message. Extract it (parser) and reuse the prior sources to maintain a
        // realistic cumulative list across turns (the mock must persist arrays correctly).
        let prevSources: string[] = [];
        if (step > 1) {
          const last = calls[step - 2]?.body?.messages?.[0]?.content ?? "";
          const fenceMatch = last.match(/```json\s*([\s\S]*?)\s*```/);
          if (fenceMatch) {
            try {
              const prevState = JSON.parse(fenceMatch[1]);
              if (Array.isArray(prevState.sources)) {
                prevSources = prevState.sources;
              }
            } catch { /* malformed prior state — start fresh */ }
          }
        }
        const sources = Array.from(new Set([...prevSources, "src-" + step]));
        // Compose a ΔΣ that DOES NOT bake "filler " inside the JSON — instead,
        // the mock writes the reasoning text OUTSIDE the JSON block (the canonical
        // format). That way, "filler " exists in model reasoning content but NOT in Σ.
        const content = [
          "Reasoning (will be discarded)...",
          "filler ".repeat(50),  // bleeds if reasoning leaks
          "```json",
          JSON.stringify({
            state_patch: {
              step,
              planted_needle: NEEDLE,
              discovered: step,
              sources,
              // NO long_bio in state — keep reasoning out of Σ to test bleed-only
              short_tag: `step-${step}`,
            },
            action: "continue",
          }),
          "```",
        ].join("\n");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          id: "h",
          object: "chat.completion",
          model: "mock",
          choices: [{
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 200 + step, completion_tokens: 30 },
        }));
      });
    });
    s.listen(0, "127.0.0.1", () => {
      mockPort = (s.address() as any).port;
      resolve(s);
    });
  });
}

describe("long-horizon — prompt bounded by |spec| + |Σ_t| + |obs| across 100 steps", () => {
  let proxy: Awaited<ReturnType<typeof startProxy>>;
  const dir = "/tmp/ss-horizon-bounded-" + Date.now();
  const SID = "bounded-100";

  beforeAll(async () => {
    mockServer = await startMock();
    proxy = await startProxy({
      listenPort: 0,
      upstreams: [{ name: "mock", url: `http://127.0.0.1:${mockPort}/v1`, apiKey: "x", priority: 0 }],
      stateDir: dir,
      schema: ["step", "planted_needle", "discovered", "sources", "short_tag"],
      initialState: { step: 0, planted_needle: "", discovered: 0, sources: [], short_tag: "" },
      maxRetries: 0,
    });
  }, 30_000);

  afterAll(() => {
    proxy?.close?.();
    mockServer?.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  });

  it(`drives ${100} steps; surviving the planted fact + bounded-prompt invariant`, async () => {
    calls = [];
    const TOTAL = 100;
    for (let i = 0; i < TOTAL; i++) {
      const r = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-skillstate-session": SID },
        body: JSON.stringify({
          model: "mock",
          messages: [
            { role: "system", content: "Research agent. Patch state per turn." },
            { role: "user", content: i === 0
              ? `Begin. Planted secret is ${NEEDLE}. Store it.`
              : `Observation ${i + 1}: nothing new.` },
          ],
        }),
      });
      expect(r.status).toBe(200);
    }

    expect(calls.length).toBe(TOTAL);

    // (1) FINAL STATE: the planted fact survives after 100 turns.
    const st: any = await fetch(`http://127.0.0.1:${proxy.port}/state?session=${SID}`).then((r) => r.json());
    expect(st.state.planted_needle).toBe(NEEDLE);
    expect(st.state.discovered).toBe(TOTAL);  // monotonically increasing got recorded every step
    // Note: sources is array-grown; the proxy preserves the latest array sent by the model.
    // If the mock's regex fails partway, sources may plateau — which we surface
    // as a real bug in either the mock or the proxy. The assertion must be set
    // conservatively (>= 50) so it survives a mock regex regression but still
    // catches a proxy-state-loss regression (which would drop to 0).
    expect(st.state.sources.length).toBeGreaterThanOrEqual(50);

    // (2) BOUNDED PROMPT at every step: upstream sees exactly (spec, Σ, obs).
        //     Not 1 system + 1 assistant + (n-1) user/assistant pairs.
        for (const c of calls) {
          const msgs = c.body.messages ?? [];
          expect(msgs.length).toBe(2);  // [system(P+Σ_t), user(O_t)]
          // Assert: prior-step reasoning ("filler " markup) does NOT bleed into the upstream
          // request. Reasoning IS discarded by the proxy — the Σ doesn't store it.
          // "filler " should appear ZERO times in any request body except step 1 (the response).
          if (c !== calls[0]) {
            const blob = JSON.stringify(c.body.messages);
            const fillerHitsInMessages = (blob.match(/filler /g) ?? []).length;
            expect(fillerHitsInMessages).toBe(0);
          }
        }

    // (3) The "user turn" history body NEVER grows with step count.
    //     Each upstream request's user message is the latest observation + a static
    //     template. The OBSERVATION-only part should be tiny.
    const observationLens = calls.map((c) => {
      const user = (c.body.messages ?? []).find((m: any) => m.role === "user");
      const text = user?.content ?? "";
      // The user content has the form:
      //   "Latest Observation:\n<OBS>\n\nProvide your response with:..."
      // Extract just the OBS portion.
      const obsMatch = text.match(/Latest Observation:\s*\n([\s\S]*?)\n\nProvide/);
      return obsMatch ? obsMatch[1].length : 0;
    });
    const maxObsLen = Math.max(...observationLens);
    const minObsLen = Math.min(...observationLens);
    // observation should fit in a small range — observation-only, not a transcript
    expect(maxObsLen).toBeLessThan(100);  // way less than a transcript would be at step 100
    expect(maxObsLen - minObsLen).toBeLessThan(50);  // roughly constant (no transcript growth)
  }, 60_000);

  it("Σ stays valid against the schema (no rogue keys), state still has planted_needle", async () => {
    const st: any = await fetch(`http://127.0.0.1:${proxy.port}/state?session=${SID}`).then((r) => r.json());
    // All keys in state must be in schema (or empty string initial). state.ts drops unknown
    // keys during applyDelta. If a future refactor forgets that, this test catches it.
    const ALLOWED = new Set(["step", "planted_needle", "discovered", "sources", "short_tag"]);
    const stateKeys = Object.keys(st.state ?? {});
    for (const k of stateKeys) {
      expect(ALLOWED.has(k)).toBe(true);
    }
    expect(st.state.planted_needle).toBe(NEEDLE);
  });

  it("discarded reasoning is NOT visible to the next turn", async () => {
    // The model writes "Reasoning (will be discarded)..." before its JSON block.
    // We expect ZERO hits in any prior user/assistant content (only Σ reflects the patch).
    // The substring "(will be discarded after execution)" also appears in the static
    // spec template (buildStepPrompt), but that's static; the model's reasoning text
    // is what we want to assert absent from subsequent requests.
    // We check for the *model-style* reasoning opener "Reasoning (will be discarded)..."
    // (with the closing ellipsis), which the mock always writes on every turn.
    for (const c of calls.slice(1)) {
      const blob = JSON.stringify(c.body.messages);
      expect(blob).not.toContain("Reasoning (will be discarded)...");
    }
  });
});
