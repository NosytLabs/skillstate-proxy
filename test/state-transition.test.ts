import { describe, expect, it } from "vitest";
import {
  commitTransition,
  newSession,
  parsePaperTransition,
  validateTransition,
} from "../src/state.js";

describe("paper transition parsing", () => {
  it("accepts exactly state_patch and action", () => {
    const parsed = parsePaperTransition('reason\n```json\n{"state_patch":{"step":1},"action":"next"}\n```');
    expect(parsed.ok).toBe(true);
    expect(parsed.transition).toEqual({ state_patch: { step: 1 }, action: "next" });
  });

  it("rejects extra envelope keys for proxy persistence", () => {
    const parsed = parsePaperTransition('```json\n{"state_patch":{"step":1},"action":"next","debug":true}\n```');
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join(" ")).toContain("exactly");
  });

  it("rejects a missing action", () => {
    const parsed = parsePaperTransition('```json\n{"state_patch":{"step":1}}\n```');
    expect(parsed.ok).toBe(false);
  });
});

describe("transaction validation", () => {
  it("does not mutate or increment on schema failure", () => {
    const session = newSession("spec", { step: 0 }, ["step"]);
    const before = structuredClone(session);
    const result = validateTransition(session, { state_patch: { extra: true }, action: "go" });
    expect(result.ok).toBe(false);
    expect(session).toEqual(before);
  });

  it("infers top-level value kinds from existing initial state", () => {
    const session = newSession("spec", { count: 0, notes: [] }, ["count", "notes"]);
    const result = validateTransition(session, { state_patch: { count: "one" }, action: "go" });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("count");
    expect(session.step).toBe(0);
  });

  it("allows explicit type contracts and null deletion", () => {
    const session = newSession("spec", { note: "x" }, ["note"]);
    const result = validateTransition(
      session,
      { state_patch: { note: null }, action: "go" },
      { stateTypes: { note: "string" } },
    );
    expect(result.ok).toBe(true);
    expect(result.candidateState).toEqual({});
    commitTransition(session, result.candidateState!);
    expect(session.state).toEqual({});
    expect(session.step).toBe(1);
  });

  it("rejects patches over maxPatchBytes without mutation", () => {
    const session = newSession("spec", { note: "" }, ["note"]);
    const result = validateTransition(
      session,
      { state_patch: { note: "x".repeat(200) }, action: "go" },
      { maxPatchBytes: 32 },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("patch");
    expect(session.step).toBe(0);
  });

  it("rejects merged state over maxStateBytes without mutation", () => {
    const session = newSession("spec", { note: "" }, ["note"]);
    const result = validateTransition(
      session,
      { state_patch: { note: "x".repeat(200) }, action: "go" },
      { maxStateBytes: 64, maxPatchBytes: 1024 },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("state");
    expect(session.state).toEqual({ note: "" });
    expect(session.step).toBe(0);
  });

  it("advances only after an accepted candidate is committed", () => {
    const session = newSession("spec", { step: 0 }, ["step"]);
    const result = validateTransition(session, { state_patch: { step: 1 }, action: "go" });
    expect(result.ok).toBe(true);
    expect(session.step).toBe(0);
    commitTransition(session, result.candidateState!);
    expect(session.state.step).toBe(1);
    expect(session.step).toBe(1);
  });

  it("can commit a native-tool no-op as one logical step", () => {
    const session = newSession("spec", { step: 0 }, ["step"]);
    commitTransition(session, session.state);
    expect(session.state).toEqual({ step: 0 });
    expect(session.step).toBe(1);
  });
});
