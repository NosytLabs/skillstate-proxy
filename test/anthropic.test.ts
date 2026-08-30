import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startProxy, type ProxyConfig } from "../src/proxy.js";

/**
 * Model-agnostic test: verify the proxy accepts Anthropic /v1/messages format
 * and translates it to OpenAI for the upstream, then denormalizes the response
 * back to Anthropic shape. This proves "works with Claude/Anthropic".
 *
 * Only runs if SKILLSTATE_LIVE=1 and a key is present.
 */
const LIVE = process.env.SKILLSTATE_LIVE === "1";
const KEY = process.env.GONKA_API_KEY || process.env.TOKENROUTER_API_KEY;
const URL = process.env.GONKA_BASE_URL || "https://api.openbroker.gonka.gg/v1";
const MODEL = process.env.MODEL || "deepseek-ai/DeepSeek-V4-Flash-0731";

describe.skipIf(!LIVE || !KEY)("model-agnostic: Anthropic /v1/messages translation", () => {
  let port = 0;
  let close: () => void;
  beforeAll(async () => {
    const cfg: Partial<ProxyConfig> = {
      listenPort: 8792,
      upstreams: [{ name: "gonka", url: URL, apiKey: KEY, priority: 0 }],
      stateDir: "/tmp/ss-anthropic-test-" + Date.now(),
      schema: ["step", "note"],
      initialState: { step: 0, note: "" },
    };
    const s = await startProxy(cfg);
    port = s.port;
    close = s.close;
  });
  afterAll(() => close && close());

  it("accepts Anthropic shape and returns Anthropic shape", async () => {
    const anthropicBody = {
      model: MODEL,
      max_tokens: 200,
      system: "You are a planning agent. Track step count in state via ```json delta.",
      messages: [{ role: "user", content: [{ type: "text", text: "Step 1: decide the plan" }] }],
    };
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify(anthropicBody),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    // Anthropic-shaped response
    expect(j.type).toBe("message");
    expect(j.role).toBe("assistant");
    expect(j.content?.[0]?.type).toBe("text");
    expect(j.usage?.input_tokens).toBeGreaterThan(0);
    // proxy headers still present
    expect(r.headers.get("x-skillstate-step")).toBe("1");
    expect(r.headers.get("x-skillstate-statekeys")).toContain("step");
  });
});
