/** Bundled pricing — USD per 1M tokens. Static entries are estimates. */
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
  "gonka": { input: 0.0012, output: 0.0012, source: "gonka.broker — 0.01 GNK/1M @ $0.12", asOf: "2026-08-29" },
  "MiniMaxAI/MiniMax-M2.7": { input: 0.0012, output: 0.0012, source: "gonka OpenBroker — 0.01 GNK/1M @ $0.12", asOf: "2026-09-07" },
  "MiniMax-M2.7": { input: 0.0012, output: 0.0012, source: "gonka OpenBroker — 0.01 GNK/1M @ $0.12", asOf: "2026-09-07" },
  "qwen3-5-9b": { input: 0.10, output: 0.15, source: "venice.ai", asOf: "2026-08-29" },
  "kimi-k3": { input: 0.15, output: 0.60, source: "venice.ai", asOf: "2026-08-29" },
  "claude-opus-4.5": { input: 15.0, output: 75.0, source: "venice.ai (via openai compat)", asOf: "2026-08-29" },
  "claude-sonnet-4.5": { input: 3.0, output: 15.0, source: "venice.ai (via openai compat)", asOf: "2026-08-29" },
  "openai/gpt-5.4": { input: 5.0, output: 25.0, source: "openrouter.ai", asOf: "2026-06-17" },
  "openai/gpt-4o": { input: 5.0, output: 15.0, source: "openai.com", asOf: "2026-06-17" },
  "anthropic/claude-sonnet-4.5": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75, source: "anthropic.com", asOf: "2026-06-17" },
  "anthropic/claude-opus-4.5": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75, source: "anthropic.com", asOf: "2026-06-17" },
  "google/gemini-2.5-pro": { input: 1.25, output: 10.0, source: "openrouter.ai", asOf: "2026-06-17" },
  "deepseek/deepseek-v3": { input: 0.27, output: 1.1, source: "openrouter.ai", asOf: "2026-08-29" },
  "deepseek/deepseek-r1": { input: 0.55, output: 2.19, source: "openrouter.ai", asOf: "2026-08-29" },
};

function bundledPrice(model: string): ModelPrice | undefined {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  const bare = model.split("/").pop()!.split(":")[0]!;
  for (const [key, price] of Object.entries(MODEL_PRICING)) {
    if (key.endsWith("/" + bare) || key === bare || model.endsWith(key)) return price;
  }
  if (/\bgonka\b/i.test(model)) return MODEL_PRICING.gonka;
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

export function gonkaCost(totalTokens: number, gnkPriceUsd = 0.12): { gnk: number; usd: number } {
  const gnk = (totalTokens / 1_000_000) * 0.01;
  return { gnk, usd: gnk * gnkPriceUsd };
}
