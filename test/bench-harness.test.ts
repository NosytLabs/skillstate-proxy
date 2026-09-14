import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  backoffMs,
  contextGrowth,
  isRetryableStatus,
  perCallPrompt,
  verdict,
  type ArmResult,
  type Step,
} from "./bench-harness.js";

const arm = (over: Partial<ArmResult> = {}): ArmResult => ({
  prompt: 0,
  comp: 0,
  usd: 0,
  toolCalls: 0,
  apiCalls: 0,
  failures: 0,
  steps: [],
  files: 0,
  findings: 0,
  ...over,
});

describe("isRetryableStatus", () => {
  it("retries transient upstream/devshard failures", () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(s)).toBe(true);
    }
  });

  it("does not retry caller errors — retrying them just wastes the run", () => {
    // 400 is the vLLM strict tool-format bug: a code bug, so retrying is wrong.
    for (const s of [400, 401, 403, 404, 422]) {
      expect(isRetryableStatus(s)).toBe(false);
    }
  });
});

describe("backoffMs", () => {
  it("grows exponentially from the base", () => {
    expect(backoffMs(0, 3000)).toBe(3000);
    expect(backoffMs(1, 3000)).toBe(6000);
    expect(backoffMs(2, 3000)).toBe(12000);
    expect(backoffMs(3, 3000)).toBe(24000);
  });

  it("caps so a long outage cannot stall a run forever", () => {
    expect(backoffMs(20, 3000, 60000)).toBe(60000);
  });
});

describe("contextGrowth", () => {
  const s = (...p: number[]): Step[] => p.map((prompt, i) => ({ step: i + 1, prompt, tools: 0 }));

  it("reports growth for a growing transcript", () => {
    expect(contextGrowth(s(500, 900, 1500))).toBeCloseTo(3, 5);
  });

  it("reports ~flat for a bounded state", () => {
    expect(contextGrowth(s(624, 650, 683))).toBeCloseTo(1.0945, 3);
  });

  it("IGNORES failed steps (prompt=0) so a dead run cannot look flat", () => {
    // 6 of 10 steps failed: naively last/first = 0/1000 = 0x "perfect", which
    // would read as an amazing result instead of a broken run.
    const steps = s(1000, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    expect(contextGrowth(steps)).toBeCloseTo(1, 5);
  });

  it("returns 0 when nothing succeeded rather than NaN", () => {
    expect(contextGrowth(s(0, 0, 0))).toBe(0);
  });
});

describe("perCallPrompt", () => {
  it("normalizes by upstream call count, not by step count", () => {
    // Same tokens, different work: the fair comparison is per call.
    expect(perCallPrompt(arm({ prompt: 22810, apiCalls: 24 }))).toBeCloseTo(950.4, 1);
    expect(perCallPrompt(arm({ prompt: 23839, apiCalls: 40 }))).toBeCloseTo(596.0, 1);
  });

  it("returns 0 instead of dividing by zero", () => {
    expect(perCallPrompt(arm({ prompt: 100, apiCalls: 0 }))).toBe(0);
  });
});

describe("verdict", () => {
  it("passes a clean run and reports per-call savings", () => {
    const v = verdict(arm({ prompt: 22810, apiCalls: 24 }), arm({ prompt: 23839, apiCalls: 40 }));
    expect(v.valid).toBe(true);
    expect(v.banner).toBe("");
    expect(v.perCallDeltaPct).toBeCloseTo(37.3, 0);
    // Raw totals must be flagged as unfair: 24 calls vs 40.
    expect(v.fairRaw).toBe(false);
  });

  it("REGRESSION GUARD: raw totals said -4.5% while per-call said -37%", () => {
    // This is the bug that shipped: the run printed a bogus regression.
    const v = verdict(arm({ prompt: 22810, apiCalls: 24 }), arm({ prompt: 23839, apiCalls: 40 }));
    expect(v.rawSavingsPct).toBeLessThan(0); // misleading negative
    expect(v.perCallDeltaPct).toBeGreaterThan(30); // real, large win
    expect(v.fairRaw).toBe(false); // and the report warns about it
  });

  it("REGRESSION GUARD: a run with failed steps is invalid, never a win", () => {
    // The fake -92.4%: 19 of 20 skillstate steps died on 502/503.
    const base = arm({ prompt: 18949, apiCalls: 22, failures: 0, steps: [{ step: 1, prompt: 399, tools: 0 }] });
    const skill = arm({ prompt: 1440, apiCalls: 3, failures: 19, steps: [{ step: 1, prompt: 609, tools: 1 }] });
    const v = verdict(base, skill);
    expect(v.valid).toBe(false);
    expect(v.failedTotal).toBe(19);
    expect(v.banner).toContain("INVALID RUN");
    expect(v.banner).toContain("NOT a result");
    // The raw maths still *looks* like a huge win — which is exactly why the
    // banner exists. Guard that we never silently present it.
    expect(v.rawSavingsPct).toBeGreaterThan(90);
  });

  it("counts failures from either arm", () => {
    expect(verdict(arm({ failures: 1 }), arm({ failures: 2 })).failedTotal).toBe(3);
    expect(verdict(arm({ failures: 1 }), arm({})).valid).toBe(false);
  });

  it("marks raw totals fair when both arms made equal calls", () => {
    const v = verdict(arm({ prompt: 1000, apiCalls: 10 }), arm({ prompt: 600, apiCalls: 10 }));
    expect(v.fairRaw).toBe(true);
    expect(v.perCallDeltaPct).toBeCloseTo(40, 5);
    expect(v.rawSavingsPct).toBeCloseTo(40, 5);
  });

  it("does not divide by zero on an empty baseline", () => {
    const v = verdict(arm(), arm());
    expect(v.perCallDeltaPct).toBe(0);
    expect(v.rawSavingsPct).toBe(0);
    expect(Number.isNaN(v.perCallDeltaPct)).toBe(false);
  });
});

describe("scenario wiring", () => {
  // The scenario registry lives in the benchmark script (not importable without
  // running it), so guard the wiring from the outside: every advertised use case
  // must have an npm script AND actually be defined in the harness.
  const SCENARIOS = ["security", "research", "email", "coding"];
  const root = join(__dirname, "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const script = readFileSync(join(root, "test", "benchmark-tools.ts"), "utf8");

  it("exposes an npm script for every documented scenario", () => {
    for (const s of SCENARIOS) {
      const name = s === "security" ? "bench:tools" : `bench:${s}`;
      expect(pkg.scripts[name], `missing npm script ${name}`).toBeTruthy();
    }
  });

  it("each scenario script selects that scenario via SKILLSTATE_SCENARIO", () => {
    for (const s of SCENARIOS.filter((x) => x !== "security")) {
      expect(pkg.scripts[`bench:${s}`]).toContain(`SKILLSTATE_SCENARIO=${s}`);
    }
  });

  it("defines every scenario key in the harness", () => {
    for (const s of SCENARIOS) {
      expect(script, `scenario '${s}' not defined`).toMatch(new RegExp(`\\n  ${s}: \\{`));
    }
  });

  it("resets per-arm state for each scenario's store", () => {
    // A store not reset between arms leaks the baseline's artifacts into the
    // skillstate numbers and silently corrupts the comparison.
    for (const store of [
      "researchStore.notes",
      "researchStore.questions",
      "emailStore.labels",
      "emailStore.drafts",
      "codingStore.reads",
      "codingStore.edits",
    ]) {
      expect(script, `${store} not reset per arm`).toContain(`${store}.length = 0;`);
    }
    expect(script).toContain("codingStore.suites = 0;");
  });
});
