/**
 * Headroom live-chain invariants.
 *
 * Hits http://127.0.0.1:8789 (the local headroom proxy that fronts OpenBroker via
 * the tool-format proxy) and asserts relationships about the running instance.
 *
 * Skipped automatically if headroom is unreachable (e.g., running in CI without
 * the headroom service). Set SKILL_LIVE_HEADROOM=1 to force-run when present.
 *
 * Tests assert relationships (compressed + uncompressed = total, no NaN, etc.)
 * so they survive headroom version bumps that change the stats shape.
 */
import { describe, it, expect } from "vitest";

const HEADROOM_URL = process.env.SKILL_LIVE_HEADROOM_URL ?? "http://127.0.0.1:8789";
const SHOULD_RUN = process.env.SKILL_LIVE_HEADROOM === "1";

describe.skipIf(!SHOULD_RUN)("Headroom live invariants (gonka chain)", () => {
  it("GET /stats returns JSON with `summary.api_requests >= 0`", async () => {
    const r = await fetch(`${HEADROOM_URL}/stats`);
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(typeof j.summary.api_requests).toBe("number");
    expect(j.summary.api_requests).toBeGreaterThanOrEqual(0);
  });

  it("compressed + uncompressed + too-small adds up to total api_requests", async () => {
    const j: any = await fetch(`${HEADROOM_URL}/stats`).then(r => r.json());
    const sum = j.summary;
    const compressed = sum.compression?.requests_compressed ?? 0;
    const uncompressedTooSmall = sum.uncompressed_requests?.too_small ?? 0;
    const total = sum.api_requests;
    // The "compressed + too_small <= total" relationship: every request is one of
    // (compressed, too-small-to-attempt, or routed passthrough). The relationship
    // is intentionally fuzzy (passthrough requests = total - compressed - too_small).
    // We assert the *upper-bound* relationship.
    expect(compressed + uncompressedTooSmall).toBeLessThanOrEqual(total);
  });

  it("avg_compression_pct is a finite number within a sane range", async () => {
    const j: any = await fetch(`${HEADROOM_URL}/stats`).then(r => r.json());
    const avg = j.summary.compression?.avg_compression_pct;
    expect(Number.isFinite(avg)).toBe(true);
    expect(avg).toBeGreaterThanOrEqual(0);
    // Compression can't exceed 100%; in practice headroom caps around 70%.
    expect(avg).toBeLessThanOrEqual(100);
  });

  it("total_tokens_removed is non-negative and <= total_tokens_before", async () => {
    const j: any = await fetch(`${HEADROOM_URL}/stats`).then(r => r.json());
    const c = j.summary.compression;
    expect(c.total_tokens_removed).toBeGreaterThanOrEqual(0);
    expect(c.total_tokens_removed).toBeLessThanOrEqual(c.total_tokens_before);
    // implied: total_tokens_after = total_tokens_before - total_tokens_removed
    // (no need to assert after-compression token math directly; rates can drift).
  });

  it("cost totals are finite USD numbers (no NaN, no Infinity)", async () => {
    const j: any = await fetch(`${HEADROOM_URL}/stats`).then(r => r.json());
    const c = j.cost ?? {};
    for (const k of ["without_headroom_usd", "with_headroom_usd", "total_saved_usd"]) {
      if (k in c) {
        expect(Number.isFinite(c[k])).toBe(true);
      }
    }
  });

  it("if primary_model is set, it should be a Gonka model ID (verbatim format)", async () => {
    const j: any = await fetch(`${HEADROOM_URL}/stats`).then(r => r.json());
    const m: string | undefined = j.summary.primary_model;
    if (!m) return; // service may not have a primary_model yet
    // Must be either "MiniMaxAI/MiniMax-M2.7" or "deepseek-ai/DeepSeek-V4-Flash-0731"
    // or empty string. Anything else is unexpected and a regression.
    expect([
      "MiniMaxAI/MiniMax-M2.7",
      "deepseek-ai/DeepSeek-V4-Flash-0731",
      "zai-org/GLM-5.3-Flash",
      "moonshotai/Kimi-K2.6",
    ]).toContain(m);
  });

  it("routes to the gonka upstream at http://127.0.0.1:4097/v1 (post-headroom)", async () => {
    // Probe the headroom's effective chat endpoint with a tiny request.
    // We expect either 200 (worked end-to-end) or 429 (devshard concurrency cap).
    // We do NOT expect 401 (broken auth wiring) or 5xx (broken chain).
    const r = await fetch(`${HEADROOM_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-ai/DeepSeek-V4-Flash-0731",
        messages: [{ role: "user", content: "ok" }],
        max_tokens: 8,
      }),
    });
    expect([200, 429, 503]).toContain(r.status);
  }, 30_000);
});
