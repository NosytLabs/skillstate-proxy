import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";

describe("CircuitBreaker", () => {
  it("opens after threshold failures and half-opens after cooldown", () => {
    const b = new CircuitBreaker("u", { failureThreshold: 2, openCooldownMs: 20 });
    expect(b.getState()).toBe("closed");
    b.recordFailure();
    expect(b.getState()).toBe("closed");
    b.recordFailure();
    expect(b.getState()).toBe("open");
    const start = Date.now();
    while (Date.now() - start < 25) { /* wait */ }
    expect(b.getState()).toBe("half-open");
    b.recordSuccess();
    expect(b.getState()).toBe("closed");
  });

  it("only allows one probe while half-open", () => {
    const b = new CircuitBreaker("u", { failureThreshold: 1, openCooldownMs: 10 });
    b.recordFailure();
    expect(b.getState()).toBe("open");
    const start = Date.now();
    while (Date.now() - start < 15) { /* wait */ }
    expect(b.canAttempt()).toBe(true);
    expect(b.canAttempt()).toBe(false);
    b.recordSuccess();
    expect(b.canAttempt()).toBe(true);
  });
});
