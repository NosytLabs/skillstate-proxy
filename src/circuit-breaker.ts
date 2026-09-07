export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  failureThreshold?: number;
  openCooldownMs?: number;
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly openCooldownMs: number;
  public readonly name: string;

  constructor(name: string, config?: CircuitBreakerConfig) {
    this.name = name;
    this.failureThreshold = config?.failureThreshold ?? 5;
    this.openCooldownMs = config?.openCooldownMs ?? 30_000;
  }

  private probing = false;

  getState(): CircuitState {
    if (this.state === "open" && Date.now() - this.openedAt >= this.openCooldownMs) {
      this.state = "half-open";
      this.probing = false;
    }
    return this.state;
  }

  /** Whether a request should be sent. Half-open allows a single probe. */
  canAttempt(): boolean {
    const s = this.getState();
    if (s === "open") return false;
    if (s === "half-open") {
      if (this.probing) return false;
      this.probing = true;
      return true;
    }
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.probing = false;
    this.state = "closed";
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    this.probing = false;
    if (this.consecutiveFailures >= this.failureThreshold || this.state === "half-open") {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
}
