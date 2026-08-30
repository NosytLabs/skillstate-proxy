import type { UpstreamConfig } from "./proxy.js";

export class RateLimiter {
  private windowTokens = new Map<string, { timestamps: number[]; values: number[] }>();
  private windowReqs = new Map<string, number[]>();

  constructor(private config: UpstreamConfig) {}

  private pruneReqs(name: string, windowMs = 60_000): void {
    const arr = this.windowReqs.get(name);
    if (!arr) return;
    const cutoff = Date.now() - windowMs;
    let i = 0;
    while (i < arr.length && arr[i]! < cutoff) i++;
    if (i > 0) this.windowReqs.set(name, arr.slice(i));
  }

  private pruneTokens(name: string, windowMs = 60_000): void {
    const buf = this.windowTokens.get(name);
    if (!buf) return;
    const cutoff = Date.now() - windowMs;
    let i = 0;
    while (i < buf.timestamps.length && buf.timestamps[i]! < cutoff) i++;
    if (i > 0) {
      this.windowTokens.set(name, {
        timestamps: buf.timestamps.slice(i),
        values: buf.values.slice(i),
      });
    }
  }

  check(estimatedTokens: number): { ok: boolean; retryAfter?: number } {
    const name = this.config.name;
    if (this.config.rpm) {
      this.pruneReqs(name);
      const arr = this.windowReqs.get(name) ?? [];
      if (arr.length >= this.config.rpm) {
        return { ok: false, retryAfter: Math.ceil((arr[0]! + 60_000 - Date.now()) / 1000) };
      }
    }
    if (this.config.tpm) {
      this.pruneTokens(name);
      const buf = this.windowTokens.get(name);
      const sum = buf ? buf.values.reduce((a, b) => a + b, 0) : 0;
      if (sum + estimatedTokens > this.config.tpm) {
        // calculate retry-after based on when the oldest token entry expires
        const oldest = buf?.timestamps[0];
        const retryAfter = oldest ? Math.ceil((oldest + 60_000 - Date.now()) / 1000) : 60;
        return { ok: false, retryAfter: Math.max(1, retryAfter) };
      }
    }
    return { ok: true };
  }

  record(tokens: number): void {
    const name = this.config.name;
    const now = Date.now();
    // RPM tracking
    const reqs = this.windowReqs.get(name) ?? [];
    reqs.push(now);
    this.windowReqs.set(name, reqs);
    // TPM tracking
    let buf = this.windowTokens.get(name);
    if (!buf) {
      buf = { timestamps: [], values: [] };
      this.windowTokens.set(name, buf);
    }
    buf.timestamps.push(now);
    buf.values.push(tokens);
  }
}
