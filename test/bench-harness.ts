/**
 * Pure, testable pieces of the long-horizon benchmark harness.
 *
 * These live outside `benchmark-tools.ts` because that file is a SCRIPT
 * (it runs main() on import), so vitest never exercises it. The logic here is
 * where silent-wrong-number bugs hide: retry classification, the definition of
 * a "valid" run, and the per-call/growth metrics. Keep it free of I/O.
 */

/** Statuses worth retrying: transient upstream/devshard trouble, not caller error. */
const RETRYABLE_STATUSES = [408, 425, 429, 500, 502, 503, 504];

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.includes(status);
}

/** Exponential backoff: base, 2*base, 4*base, ... capped by `capMs`. */
export function backoffMs(attempt: number, baseMs = 3000, capMs = 60_000): number {
  if (attempt < 0) return 0;
  return Math.min(baseMs * Math.pow(2, attempt), capMs);
}

export type Step = { step: number; prompt: number; tools: number };

export type ArmResult = {
  prompt: number;
  comp: number;
  usd: number;
  toolCalls: number;
  apiCalls: number;
  failures: number;
  steps: Step[];
  files: number;
  findings: number;
};

/**
 * Ratio of the last measured step to the first. Failed steps record prompt=0 and
 * are excluded, so a run that died early cannot masquerade as "flat growth".
 */
export function contextGrowth(steps: Step[]): number {
  const nz = steps.filter((s) => s.prompt > 0);
  if (nz.length === 0) return 0;
  return nz[nz.length - 1].prompt / nz[0].prompt;
}

/** Prompt tokens per upstream call — the workload-independent comparison. */
export function perCallPrompt(r: ArmResult): number {
  return r.apiCalls > 0 ? r.prompt / r.apiCalls : 0;
}

export type Verdict = {
  /** False when either arm lost steps; the numbers are then not a result. */
  valid: boolean;
  failedTotal: number;
  /** True when both arms made the same number of calls, so raw totals compare. */
  fairRaw: boolean;
  perCallDeltaPct: number;
  rawSavingsPct: number;
  banner: string;
};

export function verdict(base: ArmResult, skill: ArmResult): Verdict {
  const failedTotal = base.failures + skill.failures;
  const valid = failedTotal === 0;

  const bAvg = perCallPrompt(base);
  const sAvg = perCallPrompt(skill);
  const perCallDeltaPct = bAvg > 0 ? ((bAvg - sAvg) / bAvg) * 100 : 0;

  const rawSavingsPct = base.prompt > 0 ? ((base.prompt - skill.prompt) / base.prompt) * 100 : 0;
  const fairRaw = base.apiCalls === skill.apiCalls;

  const banner = valid
    ? ""
    : `\n  ⚠ INVALID RUN — ${failedTotal} failed step(s) (baseline ${base.failures}, skillstate ${skill.failures}).\n` +
      `    Failed steps are counted as 0 tokens, which UNDERSTATES one arm and can\n` +
      `    fabricate savings. Numbers below are NOT a result. Re-run when upstream is healthy.\n`;

  return { valid, failedTotal, fairRaw, perCallDeltaPct, rawSavingsPct, banner };
}
