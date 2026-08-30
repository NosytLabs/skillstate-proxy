/**
 * Bundled pricing — USD per 1M tokens.
 * Covers local, Gonka (decentralized, GNK-settled), Venice, OpenRouter, OpenAI, Anthropic.
 *
 * Sources:
 *  - openrouter.ai / provider pricing pages (2026-06-17)
 *  - gonka.broker/pricing — 0.01 GNK per 1M tokens (flat, input+output), verified 2026-08-29
 *  - coinmarketcap/coingecko — GNK ≈ $0.12-0.13 USD (2026-08-29)
 */
export interface ModelPrice {
  input: number; // USD per 1M input tokens
  output: number; // USD per 1M output tokens
  cacheRead?: number;
  cacheWrite?: number;
  source: string;
  asOf: string;
}

// Any self-hosted/local model is $0 — unknown models fall back to this.
const ZERO_LOCAL: ModelPrice = { input: 0, output: 0, source: "local (no upstream bill)", asOf: "2026-08-29" };

export const MODEL_PRICING: Record<string, ModelPrice> = {
  // ── Gonka (decentralized GPU network, gonka.ai) ─────────────────────
  // 0.01 GNK per 1M tokens (flat, input+output); USD shown at ~$0.12/GNK.
  // Developers pay per-token in GNK from their wallet; hosts earn GNK.
  "gonka": { input: 0.0012, output: 0.0012, source: "gonka.broker — 0.01 GNK/1M @ $0.12", asOf: "2026-08-29" },

  // ── Venice (venice.ai) — per 1M tokens, USD ─────────────────────────
  // https://docs.venice.ai/llms.txt
  "qwen3-5-9b": { input: 0.10, output: 0.15, source: "venice.ai", asOf: "2026-08-29" },
  "kimi-k3": { input: 0.15, output: 0.60, source: "venice.ai", asOf: "2026-08-29" },
  "claude-opus-4.5": { input: 15.0, output: 75.0, source: "venice.ai (via openai compat)", asOf: "2026-08-29" },
  "claude-sonnet-4.5": { input: 3.0, output: 15.0, source: "venice.ai (via openai compat)", asOf: "2026-08-29" },

  // ── Hosted (OpenRouter / direct) ───────────────────────────────────
  "openai/gpt-5.4": { input: 5.0, output: 25.0, source: "openrouter.ai", asOf: "2026-06-17" },
  "openai/gpt-4o": { input: 5.0, output: 15.0, source: "openai.com", asOf: "2026-06-17" },
  "anthropic/claude-sonnet-4.5": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75, source: "anthropic.com", asOf: "2026-06-17" },
  "anthropic/claude-opus-4.5": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75, source: "anthropic.com", asOf: "2026-06-17" },
  "google/gemini-2.5-pro": { input: 1.25, output: 10.0, source: "openrouter.ai", asOf: "2026-06-17" },
  "deepseek/deepseek-v3": { input: 0.27, output: 1.1, source: "openrouter.ai", asOf: "2026-08-29" },
  "deepseek/deepseek-r1": { input: 0.55, output: 2.19, source: "openrouter.ai", asOf: "2026-08-29" },
};

export function priceFor(model: string): ModelPrice {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model]!;
  // strip provider prefix: "provider/model:free" -> "model"
  const bare = model.split("/").pop()!.split(":")[0]!;
  for (const k of Object.keys(MODEL_PRICING)) {
    if (k.endsWith("/" + bare) || k === bare || model.endsWith(k)) return MODEL_PRICING[k]!;
  }
  // gonka gateway fallback — only when the model is explicitly routed via gonka
  if (/\bgonka\b/i.test(model)) return MODEL_PRICING["gonka"]!;
  return ZERO_LOCAL;
}

export function costFor(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

/** Gonka-specific: returns both GNK and USD cost. */
export function gonkaCost(totalTokens: number, gnkPriceUsd = 0.12): { gnk: number; usd: number } {
  const gnk = (totalTokens / 1_000_000) * 0.01;
  return { gnk, usd: gnk * gnkPriceUsd };
}
