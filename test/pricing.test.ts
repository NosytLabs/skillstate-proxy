import { describe, expect, it } from "vitest";
import { lookupPricing } from "../src/pricing.js";

describe("pricing lookup", () => {
  it("does not classify an unknown hosted model as free", () => {
    const r = lookupPricing("future-provider/unknown-model");
    expect(r.status).toBe("unknown");
    expect(r.costFor(1000, 1000)).toBeNull();
  });

  it("supports explicit local-zero pricing", () => {
    const r = lookupPricing("whatever", { mode: "local-zero" });
    expect(r.status).toBe("local-zero");
    expect(r.costFor(1000, 1000)).toBe(0);
  });

  it("supports explicit per-million pricing overrides", () => {
    const r = lookupPricing("whatever", { mode: "usd", inputPerMillion: 2, outputPerMillion: 6 });
    expect(r.status).toBe("known");
    expect(r.costFor(500_000, 250_000)).toBe(2.5);
  });
});
