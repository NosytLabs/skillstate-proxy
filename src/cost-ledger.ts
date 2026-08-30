import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CostRow {
  ts: string;
  upstream: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costGnk?: number;
  promptTokensViaSkillstate?: number;
  savedTokens?: number;
}

export interface CostSummary {
  totalUsd: number;
  totalGnk: number;
  byModel: Record<string, { cost: number; tokens: number }>;
  byUpstream: Record<string, number>;
}

export class CostLedger {
  private path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(join(path, ".."), { recursive: true });
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
    if (!existsSync(this.path)) return { totalUsd: 0, totalGnk: 0, byModel: {}, byUpstream: {} };
    const cutoff = Date.now() - windowMs;
    let totalUsd = 0;
    let totalGnk = 0;
    const byModel: Record<string, { cost: number; tokens: number }> = {};
    const byUpstream: Record<string, number> = {};

    for (const line of readFileSync(this.path, "utf-8").split("\n").filter(Boolean)) {
      try {
        const r = JSON.parse(line) as CostRow;
        if (new Date(r.ts).getTime() < cutoff) continue;
        if (r.costUsd !== undefined && r.costUsd !== null && Number.isFinite(r.costUsd)) {
          totalUsd += r.costUsd;
          if (r.upstream) byUpstream[r.upstream] = (byUpstream[r.upstream] ?? 0) + r.costUsd;
        }
        if (r.costGnk !== undefined && r.costGnk !== null && Number.isFinite(r.costGnk)) totalGnk += r.costGnk;
        if (r.model) {
          if (!byModel[r.model]) byModel[r.model] = { cost: 0, tokens: 0 };
          byModel[r.model]!.cost += r.costUsd && Number.isFinite(r.costUsd) ? r.costUsd : 0;
          byModel[r.model]!.tokens += (r.inputTokens || 0) + (r.outputTokens || 0);
        }
      } catch {
        // malformed line — skip
      }
    }
    return { totalUsd, totalGnk, byModel, byUpstream };
  }
}
