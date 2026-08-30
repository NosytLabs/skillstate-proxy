import type { UpstreamConfig } from "./proxy.js";
export class RateLimiter {
  private windowTokens = new Map<string, number[]>();
  private windowReqs = new Map<string, number[]>();
  constructor(private config: UpstreamConfig) {}
  private prune(name: string, window: Map<string, number[]>, windowMs = 60_000): void {
    const arr = window.get(name) ?? [];
    const cutoff = Date.now() - windowMs;
    while (arr.length > 0 && arr[0]! < cutoff) arr.shift();
    window.set(name, arr);
  }
  check(estimatedTokens: number): { ok: boolean; retryAfter?: number } {
    const name = this.config.name;
    if (this.config.rpm) {
      this.prune(name, this.windowReqs);
      const arr = this.windowReqs.get(name)!;
      if (arr.length >= this.config.rpm) return { ok: false, retryAfter: Math.ceil((arr[0]! + 60_000 - Date.now()) / 1000) };
    }
    if (this.config.tpm) {
      this.prune(name, this.windowTokens);
      const tokenArr = this.windowTokens.get(name)!;
      const sum = tokenArr.reduce((a, b) => a + b, 0);
      if (sum + estimatedTokens > this.config.tpm) return { ok: false, retryAfter: 60 };
    }
    return { ok: true };
  }
  record(tokens: number): void {
    const name = this.config.name;
    this.windowReqs.set(name, [...(this.windowReqs.get(name) ?? []), Date.now()]);
    this.windowTokens.set(name, [...(this.windowTokens.get(name) ?? []), tokens]);
  }
}
