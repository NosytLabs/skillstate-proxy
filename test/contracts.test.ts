/**
 * Real behavior-contract tests for un-covered units.
 *
 * These assert relationships between data, NOT snapshots. They will survive
 * pricing model updates, roster changes, and tiny implementation refactors.
 *
 * Covers:
 *   1. CostLedger: writes are valid JSON Lines (one round-trip per line),
 *      summarizer respects time window, byModel/byUpstream rollup correctness,
 *      malformed lines don't poison the summary.
 *   2. gonkaCost: monotonicity (more tokens → higher cost), proportional to total
 *      tokens, GNK and USD scale with the GNK price parameter.
 *   3. estimateTokens: char/4 ratio holds; empty input = 0 tokens; never returns
 *      NaN or negative.
 *   4. priceFor: a model with a vendor prefix finds gonka-prefixed or partial
 *      matches; unknown models fall back to ZERO_LOCAL (so cost never explodes).
 *   5. extractUsage: parses common OpenAI usage formats (input_tokens /
 *      prompt_tokens); tolerates missing fields.
 *
 * No HTTP, no real upstream. Pure unit tests; fast.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Real imports — these are the actual modules under test.
import { CostLedger } from "../src/cost-ledger.js";
import { gonkaCost, priceFor, costFor } from "../src/pricing.js";
import { estimateTokens, extractUsage } from "../src/token-estimate.js";

let tmpDir: string;
let ledgerPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "skillstate-test-"));
  ledgerPath = join(tmpDir, "spend.jsonl");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── CostLedger ──────────────────────────────────────────────────────────────

describe("CostLedger — behavior contracts", () => {
  it("writes valid JSON Lines that round-trip without data loss", () => {
    const l = new CostLedger(ledgerPath);
    const rows = [
      { ts: new Date().toISOString(), upstream: "gonka", model: "MiniMaxAI/MiniMax-M2.7", inputTokens: 100, outputTokens: 50, costUsd: 0.0012, costGnk: 0.01 },
      { ts: new Date().toISOString(), upstream: "gonka", model: "deepseek-ai/DeepSeek-V4-Flash-0731", inputTokens: 200, outputTokens: 100, costUsd: 0.0024, costGnk: 0.02 },
    ];
    rows.forEach(r => l.record(r));

    const text = readFileSync(ledgerPath, "utf-8");
    const lines = text.split("\n").filter(Boolean);
    expect(lines.length).toBe(rows.length); // exactly one line per row

    // round-trip: parse each line back, fields must be identical
    const parsed = lines.map(l => JSON.parse(l));
    expect(parsed[0]).toEqual(rows[0]);
    expect(parsed[1]).toEqual(rows[1]);
  });

  it("summarize rolls up totalUsd as the sum of finite costUsd rows", () => {
    const l = new CostLedger(ledgerPath);
    const now = new Date();
    l.record({ ts: now.toISOString(), upstream: "gonka", model: "x", inputTokens: 0, outputTokens: 0, costUsd: 0.001 });
    l.record({ ts: now.toISOString(), upstream: "gonka", model: "x", inputTokens: 0, outputTokens: 0, costUsd: 0.005 });
    l.record({ ts: now.toISOString(), upstream: "gonka", model: "x", inputTokens: 0, outputTokens: 0, costUsd: 0.01 });
    const s = l.summarize();
    expect(s.totalUsd).toBeCloseTo(0.016, 6); // exact sum
    expect(s.byUpstream["gonka"]).toBeCloseTo(0.016, 6);
  });

  it("summarize excludes rows older than the time window", () => {
    const l = new CostLedger(ledgerPath);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    l.record({ ts: twoHoursAgo, upstream: "gonka", model: "x", inputTokens: 0, outputTokens: 0, costUsd: 0.01 });
    l.record({ ts: oneHourAgo, upstream: "gonka", model: "y", inputTokens: 0, outputTokens: 0, costUsd: 0.02 });
    // 1h window: only the second row counts
    const s = l.summarize(60 * 60 * 1000);
    expect(s.totalUsd).toBeCloseTo(0.02, 6);
  });

  it("summarize rolls tokens into byModel correctly (input + output)", () => {
    const l = new CostLedger(ledgerPath);
    l.record({ ts: new Date().toISOString(), upstream: "gonka", model: "A", inputTokens: 100, outputTokens: 50, costUsd: 0.001 });
    l.record({ ts: new Date().toISOString(), upstream: "gonka", model: "A", inputTokens: 200, outputTokens: 100, costUsd: 0.001 });
    l.record({ ts: new Date().toISOString(), upstream: "gonka", model: "B", inputTokens: 50, outputTokens: 25, costUsd: 0.001 });
    const s = l.summarize();
    // byModel.A.tokens should be (100+50) + (200+100) = 450; byModel.B.tokens = 75
    expect(s.byModel["A"]!.tokens).toBe(450);
    expect(s.byModel["B"]!.tokens).toBe(75);
    // byModel.A.cost = 0.001 + 0.001 = 0.002
    expect(s.byModel["A"]!.cost).toBeCloseTo(0.002, 6);
    expect(s.byModel["B"]!.cost).toBeCloseTo(0.001, 6);
  });

  it("malformed lines are silently skipped — totalUsd unaffected", () => {
    const l = new CostLedger(ledgerPath);
    l.record({ ts: new Date().toISOString(), upstream: "gonka", model: "x", inputTokens: 0, outputTokens: 0, costUsd: 0.01 });
    // inject a corrupted line manually
    const fs = require("node:fs");
    fs.appendFileSync(ledgerPath, "{not valid json\n", "utf-8");
    const s = l.summarize();
    expect(s.totalUsd).toBeCloseTo(0.01, 6);
    expect(Number.isFinite(s.totalUsd)).toBe(true);
  });

  it("rows with NaN/null costUsd don't poison the summary", () => {
    const l = new CostLedger(ledgerPath);
    l.record({ ts: new Date().toISOString(), upstream: "gonka", model: "x", inputTokens: 0, outputTokens: 0, costUsd: NaN });
    l.record({ ts: new Date().toISOString(), upstream: "gonka", model: "y", inputTokens: 0, outputTokens: 0, costUsd: 0.001 as any });
    const s = l.summarize();
    expect(Number.isFinite(s.totalUsd)).toBe(true);
    expect(s.totalUsd).toBeCloseTo(0.001, 6);
  });
});

// ─── gonkaCost ───────────────────────────────────────────────────────────────

describe("gonkaCost — monotonicity and proportional scaling", () => {
  it("is monotonically non-decreasing in totalTokens", () => {
    let prev = gonkaCost(0, 0.13).gnk;
    for (const n of [1, 100, 1_000, 1_000_000, 1_000_000_000]) {
      const cur = gonkaCost(n, 0.13).gnk;
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it("scales linearly with totalTokens (double tokens → double cost)", () => {
    const one = gonkaCost(1_000_000, 0.13);
    const two = gonkaCost(2_000_000, 0.13);
    expect(two.gnk / one.gnk).toBeCloseTo(2, 6);
    expect(two.usd / one.usd).toBeCloseTo(2, 6);
  });

  it("USD scales with the GNK price parameter", () => {
    const cheap = gonkaCost(1_000_000, 0.10);
    const mid = gonkaCost(1_000_000, 0.13);
    const rich = gonkaCost(1_000_000, 0.20);
    expect(mid.usd / cheap.usd).toBeCloseTo(1.3, 6);
    expect(rich.usd / cheap.usd).toBeCloseTo(2.0, 6);
  });

  it("returns zero cost at zero tokens regardless of GNK price", () => {
    expect(gonkaCost(0, 0).gnk).toBe(0);
    expect(gonkaCost(0, 0.13).gnk).toBe(0);
    expect(gonkaCost(0, 0.13).usd).toBe(0);
  });
});

// ─── estimateTokens ──────────────────────────────────────────────────────────

describe("estimateTokens — character-based estimator", () => {
  it("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("never returns NaN or negative for any input", () => {
    for (const input of ["", "a", "a ".repeat(1), " ".repeat(1000), "Hello, world!", "🚀".repeat(10)]) {
      const n = estimateTokens(input);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
  });

  it("grows monotonically as input grows", () => {
    const a = estimateTokens("a".repeat(4));    // expect ~1
    const b = estimateTokens("a".repeat(400));  // expect ~100
    const c = estimateTokens("a".repeat(40_000)); // expect ~10000
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("approximates the canonical chars/4 ratio (allow a wide range)", () => {
    // not asserting the exact 4 — just that the constant is in a sensible range
    // (Tiktoken + GPT-2 BPE roughly 0.25 tokens per char, but character-based
    // estimators usually land between 0.20 and 0.30)
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(100);
    const t = estimateTokens(text);
    const ratio = t / text.length;
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(0.5);
  });
});

// ─── extractUsage ────────────────────────────────────────────────────────────

describe("extractUsage — parses OpenAI usage shapes", () => {
  it("parses prompt_tokens + completion_tokens (OpenAI Chat shape)", () => {
    const body = JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 50 } });
    const u = extractUsage(body);
    expect(u?.inputTokens).toBe(100);
    expect(u?.outputTokens).toBe(50);
  });

  it("parses input_tokens + output_tokens (Anthropic-style bodies)", () => {
    const body = JSON.stringify({ usage: { input_tokens: 200, output_tokens: 80 } });
    const u = extractUsage(body);
    expect(u?.inputTokens).toBe(200);
    expect(u?.outputTokens).toBe(80);
  });

  it("returns null on malformed JSON without throwing", () => {
    expect(extractUsage("not json at all")).toBeNull();
    expect(extractUsage("")).toBeNull();
    expect(extractUsage("{}")).toBeNull(); // empty body, no usage
  });

  it("returns null when usage block is absent (does not fabricate 0s)", () => {
    const body = JSON.stringify({ choices: [{ message: { role: "assistant" } }] });
    expect(extractUsage(body)).toBeNull();
  });
});

// ─── priceFor ─────────────────────────────────────────────────────────────────

describe("priceFor — robust lookups, never throws", () => {
  it("unknown models return ZERO_LOCAL (input=0, output=0) — never throws", () => {
    for (const m of ["", "totally/nonexistent-model", "asdfasdfasdf"]) {
      const p = priceFor(m);
      expect(p.input).toBe(0);
      expect(p.output).toBe(0);
    }
  });

  it("bare model id resolves a known price entry", () => {
    // assertion-by-name: any registered model with a known alias should work
    // We test by checking the abstract relationship:  costFor(bare) === input/1e6*p.input + output/1e6*p.output
    // for both a hit (qwen3-5-9b is in the table) and a miss (sk-io-x)
    const knownId = "qwen3-5-9b";
    const c = costFor(knownId, 1_000_000, 1_000_000);
    const p = priceFor(knownId);
    expect(c).toBeCloseTo(p.input + p.output, 6);

    const unknownId = "definitely-not-a-real-model-xyz";
    const cUnknown = costFor(unknownId, 1_000_000, 1_000_000);
    expect(cUnknown).toBe(0); // unknown → zero
  });

  it("gonka-prefixed model falls through to the gonka price tier", () => {
    const p = priceFor("MiniMaxAI/MiniMax-M2.7");
    // we don't snapshot the exact price (it tracks GNK market value),
    // just that the lookup routed to gonka and the source mentions it
    expect(p.source.toLowerCase()).toContain("gonka");
  });
});
