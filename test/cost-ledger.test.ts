import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CostLedger } from "../src/cost-ledger.js";

const dirs: string[] = [];
function ledger() {
  const dir = mkdtempSync(join(tmpdir(), "skillstate-ledger-"));
  dirs.push(dir);
  return new CostLedger(join(dir, "spend.jsonl"));
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("CostLedger pricing status", () => {
  it("counts tokens but not fake dollars for unknown pricing", () => {
    const l = ledger();
    l.record({
      ts: new Date().toISOString(), upstream: "u", model: "unknown/model",
      inputTokens: 100, outputTokens: 25, pricingStatus: "unknown", attemptKind: "generation",
    });
    const s = l.summarize();
    expect(s.totalUsd).toBe(0);
    expect(s.unknownPricingRows).toBe(1);
    expect(s.byModel["unknown/model"].tokens).toBe(125);
    expect(s.byModel["unknown/model"].cost).toBe(0);
  });

  it("sums known costs and distinguishes retry kinds", () => {
    const l = ledger();
    l.record({
      ts: new Date().toISOString(), upstream: "u", model: "m", inputTokens: 10, outputTokens: 5,
      costUsd: 0.01, pricingStatus: "known", attemptKind: "generation",
    });
    l.record({
      ts: new Date().toISOString(), upstream: "u", model: "m", inputTokens: 12, outputTokens: 6,
      costUsd: 0.02, pricingStatus: "known", attemptKind: "rollback-retry",
    });
    const s = l.summarize();
    expect(s.totalUsd).toBeCloseTo(0.03);
    expect(s.byAttemptKind.generation).toBe(1);
    expect(s.byAttemptKind["rollback-retry"]).toBe(1);
    expect(s.unknownPricingRows).toBe(0);
  });
});
