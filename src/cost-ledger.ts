import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface CostRow {
  ts: string;
  upstream: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Omitted when model/upstream pricing is unknown. */
  costUsd?: number;
  costGnk?: number;
  pricingStatus?: "known" | "unknown" | "local-zero" | "usage-unavailable";
  attemptKind?: "generation" | "rollback-retry" | "transport-retry" | "stream";
  promptTokensViaSkillstate?: number;
  savedTokens?: number;
}

export interface CostSummary {
  totalUsd: number;
  totalGnk: number;
  byModel: Record<string, { cost: number; tokens: number }>;
  byUpstream: Record<string, number>;
  unknownPricingRows: number;
  byAttemptKind: Record<string, number>;
}

export class CostLedger {
  private path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, "", "utf-8");
  }

  record(row: CostRow): void {
    try {
      appendFileSync(this.path, JSON.stringify(row) + "\n", "utf-8");
    } catch (err: any) {
      console.error(`[skillstate] cost-ledger: failed to write: ${err?.message ?? err}`);
    }
  }

  summarize(windowMs = 24 * 60 * 60 * 1000): CostSummary {
    const empty = (): CostSummary => ({
      totalUsd: 0,
      totalGnk: 0,
      byModel: {},
      byUpstream: {},
      unknownPricingRows: 0,
      byAttemptKind: {},
    });
    if (!existsSync(this.path)) return empty();

    const cutoff = Date.now() - windowMs;
    const summary = empty();
    for (const line of readFileSync(this.path, "utf-8").split("\n").filter(Boolean)) {
      try {
        const row = JSON.parse(line) as CostRow;
        const ts = new Date(row.ts).getTime();
        if (!Number.isFinite(ts) || ts < cutoff) continue;

        const input = Number.isFinite(row.inputTokens) ? row.inputTokens : 0;
        const output = Number.isFinite(row.outputTokens) ? row.outputTokens : 0;
        const knownUsd = typeof row.costUsd === "number" && Number.isFinite(row.costUsd);

        if (knownUsd) {
          summary.totalUsd += row.costUsd!;
          if (row.upstream) summary.byUpstream[row.upstream] = (summary.byUpstream[row.upstream] ?? 0) + row.costUsd!;
        }
        if (typeof row.costGnk === "number" && Number.isFinite(row.costGnk)) summary.totalGnk += row.costGnk;
        if (row.pricingStatus === "unknown") summary.unknownPricingRows += 1;
        if (row.attemptKind) summary.byAttemptKind[row.attemptKind] = (summary.byAttemptKind[row.attemptKind] ?? 0) + 1;

        if (row.model) {
          if (!summary.byModel[row.model]) summary.byModel[row.model] = { cost: 0, tokens: 0 };
          summary.byModel[row.model]!.tokens += input + output;
          if (knownUsd) summary.byModel[row.model]!.cost += row.costUsd!;
        }
      } catch {
        // Malformed lines are skipped so one partial write cannot break /cost.
      }
    }
    return summary;
  }
}
