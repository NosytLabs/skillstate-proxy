import { describe, expect, it } from "vitest";
import { lookupPricing } from "../src/pricing.js";

function price(model: string) {
  const r = lookupPricing(model);
  expect(r.status).toBe("known");
  return r.price!;
}

describe("verified bundled pricing as of 2026-09-10", () => {
  it("uses current direct OpenAI rates", () => {
    expect(price("gpt-4o")).toMatchObject({ input: 2.5, output: 10 });
    expect(price("gpt-5.4")).toMatchObject({ input: 2.5, output: 15 });
    expect(price("gpt-5.6")).toMatchObject({ input: 4, output: 20 });
    expect(price("gpt-5.6-terra")).toMatchObject({ input: 2, output: 12 });
    expect(price("gpt-5.6-luna")).toMatchObject({ input: 0.2, output: 1.2 });
  });

  it("uses current direct Anthropic standard global rates", () => {
    expect(price("anthropic/claude-opus-4.5")).toMatchObject({ input: 5, output: 25 });
    expect(price("anthropic/claude-sonnet-4.6")).toMatchObject({ input: 3, output: 15 });
  });

  it("uses current Venice model rates only for Venice model ids", () => {
    expect(price("qwen3-5-9b")).toMatchObject({ input: 0.10, output: 0.15 });
    expect(price("kimi-k3")).toMatchObject({ input: 4.69, output: 23.44 });
    expect(price("claude-sonnet-4-5")).toMatchObject({ input: 3.75, output: 18.75 });
    expect(price("claude-opus-4-5")).toMatchObject({ input: 6, output: 30 });
  });

  it("does not bake volatile Gonka/GNK USD conversion into generic model pricing", () => {
    expect(lookupPricing("MiniMaxAI/MiniMax-M2.7").status).toBe("unknown");
  });
});
