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

  getState(): CircuitState {
    if (this.state === "open" && Date.now() - this.openedAt >= this.openCooldownMs) {
      this.state = "half-open";
    }
    return this.state;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
}
