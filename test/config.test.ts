import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHomePath, normalizeConfigValues } from "../src/config.js";

describe("configuration normalization", () => {
  it("expands a leading tilde in filesystem paths", () => {
    expect(expandHomePath("~/.skillstate/state")).toBe(join(homedir(), ".skillstate/state"));
    expect(expandHomePath("/tmp/state")).toBe("/tmp/state");
  });

  it("infers a fixed schema from initial state keys", () => {
    const c = normalizeConfigValues({
      listenPort: 8789,
      stateDir: "~/.skillstate/state",
      costLedgerPath: "~/.skillstate/spend.jsonl",
      upstreams: [{ name: "x", url: "https://example.com/v1", priority: 0 }],
      schema: [],
      initialState: { step: 0, notes: [] },
    });
    expect(c.schema).toEqual(["step", "notes"]);
    expect(c.stateDir.startsWith("~/")).toBe(false);
  });

  it("rejects invalid upstream URLs", () => {
    expect(() => normalizeConfigValues({
      listenPort: 8789,
      stateDir: "/tmp/state",
      costLedgerPath: "/tmp/cost",
      upstreams: [{ name: "x", url: "not a url", priority: 0 }],
      schema: [], initialState: {},
    })).toThrow(/upstream/i);
  });

  it("rejects invalid numeric limits", () => {
    expect(() => normalizeConfigValues({
      listenPort: -1,
      stateDir: "/tmp/state",
      costLedgerPath: "/tmp/cost",
      upstreams: [{ name: "x", url: "https://example.com/v1", priority: 0 }],
      schema: [], initialState: {}, maxStateBytes: 0,
    })).toThrow();
  });
});
