import assert from "node:assert/strict";
import { test } from "vitest";
import { RateLimiter } from "../src/rate-limiter.js";
import type { UpstreamConfig } from "../src/proxy.js";

const make = (limits: Partial<Pick<UpstreamConfig, "rpm" | "tpm">>) =>
  new RateLimiter({ name: "fixture", url: "http://127.0.0.1:1", priority: 0, ...limits });

function clock(run: (setTime: (value: number) => void) => void): void {
  const original = Date.now;
  let now = 0;
  Date.now = () => now;
  try { run(value => { now = value; }); }
  finally { Date.now = original; }
}

// Private-history inspection is intentional: request outcomes cannot reveal
// retained arrays for disabled limits. This adds no production inspection API.
const history = (limiter: RateLimiter) => limiter as unknown as {
  windowReqs: Map<string, number[]>;
  windowTokens: Map<string, { timestamps: number[]; values: number[] }>;
};

test("disabled limits retain no request or token histories", () => clock(time => {
  const limiter = make({});
  for (let i = 0; i < 1000; i++) { time(i * 1000); limiter.record(10); }
  assert.equal(history(limiter).windowReqs.size, 0);
  assert.equal(history(limiter).windowTokens.size, 0);
  assert.deepEqual(limiter.check(100), { ok: true });
}));

test("RPM-only tracking never accumulates disabled token history", () => clock(time => {
  const limiter = make({ rpm: 10 });
  for (let i = 0; i < 100; i++) { time(i * 60000); limiter.record(10); }
  assert.equal(history(limiter).windowTokens.size, 0);
  assert.equal(history(limiter).windowReqs.get("fixture")!.length, 1);
}));

test("TPM-only tracking never accumulates disabled request history", () => clock(time => {
  const limiter = make({ tpm: 100 });
  for (let i = 0; i < 100; i++) { time(i * 60000); limiter.record(10); }
  assert.equal(history(limiter).windowReqs.size, 0);
  assert.equal(history(limiter).windowTokens.get("fixture")!.timestamps.length, 1);
}));

test("record prunes expired entries even without intervening checks", () => clock(time => {
  const limiter = make({ rpm: 10, tpm: 100 });
  limiter.record(10);
  time(60000); limiter.record(20);
  assert.deepEqual(history(limiter).windowReqs.get("fixture"), [60000]);
  assert.deepEqual(history(limiter).windowTokens.get("fixture"), { timestamps: [60000], values: [20] });
}));

test("request expires at the exact minute boundary", () => clock(time => {
  const limiter = make({ rpm: 1 });
  limiter.record(1); time(60000);
  assert.deepEqual(limiter.check(1), { ok: true });
  assert.equal(history(limiter).windowReqs.size, 0);
}));

test("tokens expire at the exact minute boundary", () => clock(time => {
  const limiter = make({ tpm: 100 });
  limiter.record(100); time(60000);
  assert.deepEqual(limiter.check(100), { ok: true });
  assert.equal(history(limiter).windowTokens.size, 0);
}));

test("TPM retry waits for enough entries to expire, not just the oldest", () => clock(time => {
  const limiter = make({ tpm: 100 });
  time(1000); limiter.record(20);
  time(11000); limiter.record(50);
  time(21000);
  assert.deepEqual(limiter.check(70), { ok: false, retryAfter: 50 });
}));

test("epoch-zero timestamps are valid when calculating retry", () => clock(time => {
  const limiter = make({ tpm: 100 });
  limiter.record(90); time(59000);
  assert.deepEqual(limiter.check(20), { ok: false, retryAfter: 1 });
}));

test("active requests remain limited one millisecond before expiry", () => clock(time => {
  const limiter = make({ rpm: 1 });
  limiter.record(1); time(59999);
  assert.deepEqual(limiter.check(1), { ok: false, retryAfter: 1 });
}));

test("active token totals are enforced and exact remaining capacity passes", () => clock(() => {
  const limiter = make({ tpm: 100 }); limiter.record(40);
  assert.deepEqual(limiter.check(60), { ok: true });
  assert.equal(limiter.check(61).ok, false);
}));

test("zero-token requests still count toward RPM", () => clock(() => {
  const limiter = make({ rpm: 1, tpm: 100 }); limiter.record(0);
  assert.equal(limiter.check(1).ok, false);
}));

test("one request larger than TPM is rejected with bounded retry", () => clock(() => {
  assert.deepEqual(make({ tpm: 100 }).check(101), { ok: false, retryAfter: 60 });
}));

test("RPM retry accounts for more recorded completions than available slots", () => clock(time => {
  const limiter = make({ rpm: 2 });
  time(1000); limiter.record(1);
  time(11000); limiter.record(1);
  time(21000); limiter.record(1);
  time(31000);
  assert.deepEqual(limiter.check(1), { ok: false, retryAfter: 40 });
}));

test("combined limits wait until both request and token capacity is available", () => clock(time => {
  const limiter = make({ rpm: 2, tpm: 100 });
  time(1000); limiter.record(20);
  time(11000); limiter.record(50);
  time(21000);
  assert.deepEqual(limiter.check(70), { ok: false, retryAfter: 50 });
}));
