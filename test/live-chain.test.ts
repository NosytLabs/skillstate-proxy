/**
 * LIVE chain-integration test — verifies the full proxy chain responds correctly.
 *
 * Set SKILL_LIVE_CHAIN=1 + obk key to run. Skipped by default.
 *
 * Chain: this proxy → http://127.0.0.1:8789/v1 (headroom) → http://127.0.0.1:4097/v1 (tool-format proxy) → api.openbroker.gonka.gg/v1
 *
 * Asserts (invariant, not snapshot):
 *   1. /v1/models lists M2.7 + DeepSeek-V4-Flash-0731 in the live OpenBroker roster
 *   2. POST /v1/chat/completions returns 200 with a non-empty assistant message
 *   3. The state dir grows when a session id is passed
 */
import { describe, it, expect, beforeAll } from "vitest";
import { startProxy, type ProxyConfig } from "../src/proxy.js";
import { existsSync, statSync } from "node:fs";

const LIVE = process.env.SKILL_LIVE_CHAIN === "1";
const HEADROOM_URL = process.env.SKILL_LIVE_CHAIN_HEADROOM ?? "http://127.0.0.1:8789/v1";
const UPSTREAM_KEY = process.env.OBK_API_KEY ?? "sk-skillstate-local";
const MODEL = process.env.SKILL_LIVE_MODEL ?? "deepseek-ai/DeepSeek-V4-Flash-0731";

describe.skipIf(!LIVE)("SKILL.state live chain (headroom → openbroker)", () => {
  let port = 0;
  let stopFn: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const cfg: ProxyConfig = {
      listenPort: 0,
      upstreams: [{ name: "headroom-gonka", url: HEADROOM_URL, apiKey: UPSTREAM_KEY, priority: 0 }],
      stateDir: "/tmp/skillstate-live-chain-test-state",
      schema: ["step", "findings"],
      initialState: { step: 0, findings: [] },
      discardReasoning: true,
      costLedgerPath: "/tmp/skillstate-live-chain-test-cost.jsonl",
    };
    const started = await startProxy(cfg);
    port = started.port;
    stopFn = started.stop;
  }, 30_000);

  it("lists M2.7 + DeepSeek-V4-Flash-0731 in the live upstream roster", async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/v1/models`);
    expect(resp.status).toBe(200);
    const j: any = await resp.json();
    const ids = (j.data ?? j.models ?? []).map((m: any) => m.id);
    // invariant: both DeepSeek and M2.7 must be in the live roster (verified 2026-09-13)
    expect(ids).toContain("MiniMaxAI/MiniMax-M2.7");
    expect(ids).toContain("deepseek-ai/DeepSeek-V4-Flash-0731");
  }, 60_000);

  it("completes a chat request end-to-end through headroom → openbroker", async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${UPSTREAM_KEY}`,
        "Content-Type": "application/json",
        "X-Skillstate-Session": "live-chain-integration-test-1",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "user", content: "Reply with exactly: CHAIN-OK" },
        ],
        max_tokens: 16,
      }),
    });
    expect(resp.status).toBe(200);
    const j: any = await resp.json();
    const content = j.choices?.[0]?.message?.content ?? "";
    // invariant: a non-empty content field must come back (response NOT a 429 / queue-hang)
    expect(content.length).toBeGreaterThan(0);
  }, 120_000);

  it("writes a state file when x-skillstate-session is supplied", () => {
    const f = "/tmp/skillstate-live-chain-test-state/live-chain-integration-test-1.json";
    expect(existsSync(f)).toBe(true);
    expect(statSync(f).size).toBeGreaterThan(0);
  }, 5_000);
});
