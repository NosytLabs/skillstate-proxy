import type { UpstreamConfig } from "./proxy.js";

const WINDOW_MS = 60_000;
type TokenWindow = { timestamps: number[]; values: number[] };

/** Find the first entry still inside the half-open rolling window. */
function firstActive(timestamps: number[], cutoff: number): number {
  let index = 0;
  while (index < timestamps.length && timestamps[index]! <= cutoff) index++;
  return index;
}

export class RateLimiter {
  private windowTokens = new Map<string, TokenWindow>();
  private windowReqs = new Map<string, number[]>();

  constructor(private config: UpstreamConfig) {}

  /** Prune on checks AND records; disabled counters must not retain history. */
  private prune(name: string, now: number): void {
    const cutoff = now - WINDOW_MS;
    const requests = this.windowReqs.get(name);
    if (!this.config.rpm) this.windowReqs.delete(name);
    else if (requests) {
      const start = firstActive(requests, cutoff);
      if (start === requests.length) this.windowReqs.delete(name);
      else if (start > 0) this.windowReqs.set(name, requests.slice(start));
    }

    const tokens = this.windowTokens.get(name);
    if (!this.config.tpm) this.windowTokens.delete(name);
    else if (tokens) {
      const start = firstActive(tokens.timestamps, cutoff);
      if (start === tokens.timestamps.length) this.windowTokens.delete(name);
      else if (start > 0) {
        this.windowTokens.set(name, {
          timestamps: tokens.timestamps.slice(start),
          values: tokens.values.slice(start),
        });
      }
    }
  }

  check(estimatedTokens: number): { ok: boolean; retryAfter?: number } {
    const name = this.config.name;
    const now = Date.now();
    this.prune(name, now);
    const retryAt = (timestamp: number) => Math.max(1, Math.ceil((timestamp + WINDOW_MS - now) / 1000));

    if (this.config.rpm) {
      const requests = this.windowReqs.get(name) ?? [];
      if (requests.length >= this.config.rpm) {
        return { ok: false, retryAfter: retryAt(requests[0]!) };
      }
    }
    if (this.config.tpm) {
      const tokens = this.windowTokens.get(name);
      let total = tokens ? tokens.values.reduce((sum, value) => sum + value, 0) : 0;
      if (total + estimatedTokens > this.config.tpm) {
        // Wait until enough tokens expire, not merely the first entry. A
        // request exceeding the entire limit retains the existing 60s fallback.
        if (tokens && estimatedTokens <= this.config.tpm) {
          for (let i = 0; i < tokens.values.length; i++) {
            total -= tokens.values[i]!;
            if (total + estimatedTokens <= this.config.tpm) {
              return { ok: false, retryAfter: retryAt(tokens.timestamps[i]!) };
            }
          }
        }
        return { ok: false, retryAfter: 60 };
      }
    }
    return { ok: true };
  }

  record(tokens: number): void {
    const name = this.config.name;
    const now = Date.now();
    this.prune(name, now);
    if (this.config.rpm) {
      const requests = this.windowReqs.get(name) ?? [];
      requests.push(now);
      this.windowReqs.set(name, requests);
    }
    if (this.config.tpm) {
      const buffer = this.windowTokens.get(name) ?? { timestamps: [], values: [] };
      buffer.timestamps.push(now);
      buffer.values.push(tokens);
      this.windowTokens.set(name, buffer);
    }
  }
}
