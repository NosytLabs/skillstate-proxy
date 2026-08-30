import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startProxy, type ProxyConfig } from "../src/proxy.js";

/**
 * Tests Anthropic /v1/messages → OpenAI upstream → Anthropic response shape.
 * Requires SKILLSTATE_LIVE=1 + SKILLSTATE_API_KEY.
 */
const LIVE = process.env.SKILLSTATE_LIVE === "1";
const KEY = process.env.SKILLSTATE_API_KEY;
const URL = process.env.SKILLSTATE_UPSTREAM ?? "https://api.venice.ai/api/v1";
const MODEL = process.env.SKILLSTATE_MODEL ?? "qwen3-5-9b";

describe.skipIf(!LIVE || !KEY)("anthropic: /v1/messages translation", () => {
  let port = 0;
  let close: () => void;
  beforeAll(async () => {
    const cfg: Partial<ProxyConfig> = {
      listenPort: 0,
      upstreams: [{ name: "upstream", url: URL, apiKey: KEY, priority: 0 }],
      stateDir: "/tmp/ss-anthropic-" + Date.now(),
      schema: ["step", "note"],
      initialState: { step: 0, note: "" },
    };
    const s = await startProxy(cfg);
    port = s.port;
    close = s.close;
  });
  afterAll(() => close?.());

  it("accepts Anthropic shape and returns Anthropic shape", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL, max_tokens: 200,
        system: "You are a planning agent. Track step count in state via ```json delta.",
        messages: [{ role: "user", content: [{ type: "text", text: "Step 1: decide the plan" }] }],
      }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.type).toBe("message");
    expect(j.role).toBe("assistant");
    expect(j.content?.[0]?.type).toBe("text");
    expect(j.usage?.input_tokens).toBeGreaterThan(0);
    expect(r.headers.get("x-skillstate-step")).toBe("1");
    expect(r.headers.get("x-skillstate-statekeys")).toContain("step");
  });
});
