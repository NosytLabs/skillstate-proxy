/**
 * Bundled pricing — USD per 1M tokens.
 *
 * Keep this intentionally small: entries are only included when a current
 * first-party/provider page was verified. Unknown models stay unknown instead
 * of inheriting an unrelated or stale zero/price.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  source: string;
  asOf: string;
}

export type UpstreamPricing =
  | { mode: "local-zero" }
  | { mode: "usd"; inputPerMillion: number; outputPerMillion: number };

export type PricingStatus = "known" | "unknown" | "local-zero";

export interface PricingLookup {
  status: PricingStatus;
  price?: ModelPrice;
  costFor(inputTokens: number, outputTokens: number): number | null;
}

const ZERO_LOCAL: ModelPrice = { input: 0, output: 0, source: "explicit local upstream", asOf: "runtime" };

export const MODEL_PRICING: Record<string, ModelPrice> = {
  // OpenAI direct API, verified 2026-09-10 from developers.openai.com.
  "openai/gpt-6-astra": { input: 10, output: 50, cacheRead: 1, source: "OpenAI API model catalog", asOf: "2026-09-10" },
  "openai/gpt-5.6": { input: 4, output: 20, cacheRead: 0.4, source: "OpenAI GPT-5.6 Sol model page", asOf: "2026-09-10" },
  "openai/gpt-5.6-sol": { input: 4, output: 20, cacheRead: 0.4, source: "OpenAI GPT-5.6 Sol model page", asOf: "2026-09-10" },
  "openai/gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, source: "OpenAI GPT-5.6 Terra model page", asOf: "2026-09-10" },
  "openai/gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, source: "OpenAI GPT-5.6 Luna model page", asOf: "2026-09-10" },
  "openai/gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, source: "OpenAI GPT-5.4 model page", asOf: "2026-09-10" },
  "openai/gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25, source: "OpenAI GPT-4o model page", asOf: "2026-09-10" },

  // Anthropic direct API standard global list prices, verified 2026-09-10.
  "anthropic/claude-sonnet-4.6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, source: "Anthropic Claude API list prices", asOf: "2026-09-10" },
  "anthropic/claude-sonnet-4.5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, source: "Anthropic Claude API list prices", asOf: "2026-09-10" },
  "anthropic/claude-opus-4.7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, source: "Anthropic Claude API list prices", asOf: "2026-09-10" },
  "anthropic/claude-opus-4.6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, source: "Anthropic Claude API list prices", asOf: "2026-09-10" },
  "anthropic/claude-opus-4.5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, source: "Anthropic Claude API list prices", asOf: "2026-09-10" },

  // Venice OpenAI-compatible API model ids, verified 2026-09-10 from Venice model pages.
  "qwen3-5-9b": { input: 0.10, output: 0.15, source: "Venice Qwen 3.5 9B model page", asOf: "2026-09-10" },
  "kimi-k3": { input: 4.69, output: 23.44, cacheRead: 0.47, source: "Venice Kimi K3 model page", asOf: "2026-09-10" },
  "kimi-k3-fast-api": { input: 4.50, output: 22.50, source: "Venice Kimi K3 Fast API model page", asOf: "2026-09-10" },
  "claude-sonnet-4-5": { input: 3.75, output: 18.75, cacheRead: 0.38, source: "Venice Claude Sonnet 4.5 model page", asOf: "2026-09-10" },
  "claude-opus-4-5": { input: 6, output: 30, cacheRead: 0.60, source: "Venice Claude Opus 4.5 model page", asOf: "2026-09-10" },
  "openai-gpt-56-sol": { input: 6.25, output: 37.50, cacheRead: 0.63, source: "Venice GPT-5.6 Sol model page", asOf: "2026-09-10" },
};

function bundledPrice(model: string): ModelPrice | undefined {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  const bare = model.split("/").pop()!.split(":")[0]!;
  for (const [key, price] of Object.entries(MODEL_PRICING)) {
    if (key.endsWith("/" + bare) || key === bare || model.endsWith(key)) return price;
  }
  return undefined;
}

export function lookupPricing(model: string, override?: UpstreamPricing): PricingLookup {
  if (override?.mode === "local-zero") {
    return { status: "local-zero", price: ZERO_LOCAL, costFor: () => 0 };
  }
  if (override?.mode === "usd") {
    const price: ModelPrice = {
      input: override.inputPerMillion,
      output: override.outputPerMillion,
      source: "upstream config override",
      asOf: "runtime",
    };
    return {
      status: "known",
      price,
      costFor: (inputTokens, outputTokens) => (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output,
    };
  }
  const price = bundledPrice(model);
  if (!price) return { status: "unknown", costFor: () => null };
  return {
    status: "known",
    price,
    costFor: (inputTokens, outputTokens) => (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output,
  };
}

/** Backwards-compatible helper. Prefer lookupPricing() for honest unknown handling. */
export function priceFor(model: string): ModelPrice {
  return bundledPrice(model) ?? ZERO_LOCAL;
}

/** Backwards-compatible helper. Prefer lookupPricing().costFor(). */
export function costFor(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

/**
 * Gonka Broker native retail rate, verified 2026-09-10: 0.01 GNK / 1M billed tokens.
 * The protocol-level on-chain price is dynamic and can differ by model and block.
 * USD is returned only when the caller supplies a contemporaneous GNK/USD price.
 */
export function gonkaCost(totalTokens: number, gnkPriceUsd?: number): { gnk: number; usd: number | null } {
  const gnk = (totalTokens / 1_000_000) * 0.01;
  return { gnk, usd: gnkPriceUsd === undefined ? null : gnk * gnkPriceUsd };
}
