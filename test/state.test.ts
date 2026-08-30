import { describe, it, expect } from "vitest";
import {
  mergeState,
  extractDelta,
  buildStepPrompt,
  applyDelta,
  newSession,
} from "../src/state.js";

describe("mergeState (null-deletion semantics)", () => {
  it("overwrites scalar keys", () => {
    const r = mergeState({ a: 1, b: 2 }, { b: 9 });
    expect(r).toEqual({ a: 1, b: 9 });
  });
  it("deletes keys set to null", () => {
    const r = mergeState({ a: 1, b: 2 }, { a: null });
    expect(r).toEqual({ b: 2 });
  });
  it("recursively merges nested objects", () => {
    const r = mergeState({ f: { x: 1, y: 2 } }, { f: { y: 9 } });
    expect(r).toEqual({ f: { x: 1, y: 9 } });
  });
  it("does not mutate the base", () => {
    const base = { a: 1 };
    mergeState(base, { b: 2 });
    expect(base).toEqual({ a: 1 });
  });
});

describe("extractDelta (paper format: state_patch + action)", () => {
  it("parses paper format with state_patch and action, marks valid", () => {
    const txt = 'Reasoning here.\n```json\n{"state_patch": {"step": 3, "flag": "found"}, "action": "ls"}\n```';
    const { delta, action, valid, format } = extractDelta(txt);
    expect(delta).toEqual({ step: 3, flag: "found" });
    expect(action).toBe("ls");
    expect(valid).toBe(true);
    expect(format).toBe("paper");
  });

  it("parses whole-output paper format (state_patch + action at top level)", () => {
    const txt = JSON.stringify({ state_patch: { a: 1 }, action: "do it" });
    const { delta, action, valid, format } = extractDelta(txt);
    expect(delta).toEqual({ a: 1 });
    expect(action).toBe("do it");
    expect(valid).toBe(true);
    expect(format).toBe("paper");
  });

  it("legacy fenced block (whole body is the delta) — valid=false (no state_patch wrapper)", () => {
    const txt = '```json\n{"step": 1}\n```';
    const { delta, valid, format } = extractDelta(txt);
    expect(delta).toEqual({ step: 1 });
    expect(valid).toBe(false);
    expect(format).toBe("legacy");
  });

  it("returns valid=false on plain text (triggers rollback-retry)", () => {
    const { delta, valid, format } = extractDelta("just reasoning, no json");
    expect(delta).toEqual({});
    expect(valid).toBe(false);
    expect(format).toBe("none");
  });

  it("null in state_patch deletes a key (null-deletion)", () => {
    const txt = '```json\n{"state_patch": {"old": null, "new": "x"}, "action": "go"}\n```';
    const { delta, valid } = extractDelta(txt);
    expect(delta).toEqual({ old: null, new: "x" });
    expect(valid).toBe(true);
  });
});

describe("extractDelta (legacy formats — backward compat)", () => {
  it("parses a fenced json state block", () => {
    const txt = "My reasoning here.\n```json\n{\"step\": 3, \"flag\": \"found\"}\n```\nAction: done.";
    const { delta } = extractDelta(txt);
    expect(delta).toEqual({ step: 3, flag: "found" });
  });
  it("parses inline STATE: marker", () => {
    const txt = "thinking...\nSTATE: {\"k\": 5}";
    const { delta } = extractDelta(txt);
    expect(delta).toEqual({ k: 5 });
  });
  it("handles whole-output JSON with state key", () => {
    const txt = JSON.stringify({ state: { a: 1 }, answer: "x" });
    const { delta } = extractDelta(txt);
    expect(delta).toEqual({ a: 1 });
  });
  it("returns empty delta when no state present", () => {
    const { delta } = extractDelta("just some text with no json");
    expect(delta).toEqual({});
  });
});

describe("buildStepPrompt + applyDelta (SKILL.state cycle)", () => {
  it("builds (P, Σ, O) and applies a delta, discarding reasoning", () => {
    const s = newSession("TASK: find the flag", { flags: [] as string[] }, []);
    const obs = "ran `ls`, found secret.txt";
    const { system, user } = buildStepPrompt(s, obs);
    expect(system).toContain("TASK: find the flag");
    expect(system).toContain('"flags"');
    expect(user).toContain("secret.txt");

    // simulate model output
    const modelOut = "I should record the flag file.\n```json\n{\"flags\": [\"secret.txt\"]}\n```\nNow grep it.";
    const { delta } = extractDelta(modelOut);
    const { warnings } = applyDelta(s, delta);
    expect(warnings).toEqual([]);
    expect(s.state.flags).toEqual(["secret.txt"]);
    expect(s.step).toBe(1);
  });

  it("enforces schema: drops non-schema keys, reports warnings", () => {
    const s = newSession("spec", { a: 1 }, ["a"]);
    const { warnings, merged } = applyDelta(s, { a: 2, b: 3 } as any);
    expect(s.state).toEqual({ a: 2 });
    expect(merged).toEqual({ a: 2 });
    expect(warnings.some(w => w.includes("b"))).toBe(true);
  });

  it("validation: rejects non-object delta", () => {
    const s = newSession("spec", { a: 1 }, ["a"]);
    const { warnings } = applyDelta(s, null as any);
    expect(warnings.length).toBeGreaterThan(0);
    expect(s.state).toEqual({ a: 1 }); // unchanged
  });

  it("validation: null values delete keys (paper §null-deletion)", () => {
    const s = newSession("spec", { a: 1, b: 2 }, ["a", "b"]);
    const { merged } = applyDelta(s, { a: null });
    expect(merged).toEqual({ b: 2 });
    expect(s.state).toEqual({ b: 2 });
  });
});

describe("complexity property (bounded prompt size)", () => {
  it("prompt size stays O(1) regardless of step count", () => {
    const s = newSession("P", {}, []);
    for (let i = 0; i < 100; i++) {
      applyDelta(s, { [`k${i}`]: i });
    }
    const { system, user } = buildStepPrompt(s, "latest obs");
    // state grows but does NOT include history; prompt is one state snapshot + obs
    expect(user).toContain("latest obs");
    expect(system).not.toContain("step 1");
    expect(system).not.toContain("step 50");
  });
});
