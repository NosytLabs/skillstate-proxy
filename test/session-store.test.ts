import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, safeSessionId } from "../src/session-store.js";
import { newSession } from "../src/state.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "skillstate-store-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("keeps same session id isolated between store instances", () => {
    const a = new SessionStore({ stateDir: tempDir(), ttlMs: 60_000 });
    const b = new SessionStore({ stateDir: tempDir(), ttlMs: 60_000 });
    a.save("same", newSession("a", { value: "A" }, ["value"]));
    b.save("same", newSession("b", { value: "B" }, ["value"]));
    expect(a.get("same")?.state.value).toBe("A");
    expect(b.get("same")?.state.value).toBe("B");
    a.close(); b.close();
  });

  it("persists atomically without leaving temp files", () => {
    const dir = tempDir();
    const s = new SessionStore({ stateDir: dir, ttlMs: 60_000 });
    s.save("atomic", newSession("spec", { n: 1 }, ["n"]));
    expect(JSON.parse(readFileSync(join(dir, "atomic.json"), "utf8")).state.n).toBe(1);
    expect(readdirSync(dir).filter(n => n.includes(".tmp-"))).toEqual([]);
    s.close();
  });

  it("rejects corrupted or invalid persisted sessions", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "bad.json"), "{not-json", "utf8");
    writeFileSync(join(dir, "shape.json"), JSON.stringify({ step: "wrong" }), "utf8");
    const s = new SessionStore({ stateDir: dir, ttlMs: 60_000 });
    expect(s.get("bad")).toBeNull();
    expect(s.get("shape")).toBeNull();
    s.close();
  });

  it("expires stale sessions", async () => {
    const s = new SessionStore({ stateDir: tempDir(), ttlMs: 5 });
    s.save("old", newSession("spec", { n: 1 }, ["n"]));
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(s.get("old")).toBeNull();
    s.close();
  });

  it("serializes overlapping work for one session", async () => {
    const s = new SessionStore({ stateDir: tempDir(), ttlMs: 60_000 });
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = s.withSessionLock("one", async () => {
      events.push("first-start");
      await gate;
      events.push("first-end");
    });
    const second = s.withSessionLock("one", async () => {
      events.push("second-start");
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(events).toEqual(["first-start"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second-start"]);
    s.close();
  });

  it("allows different sessions to proceed concurrently", async () => {
    const s = new SessionStore({ stateDir: tempDir(), ttlMs: 60_000 });
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = s.withSessionLock("one", async () => {
      events.push("one-start");
      await gate;
    });
    const second = s.withSessionLock("two", async () => {
      events.push("two-start");
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(events).toContain("one-start");
    expect(events).toContain("two-start");
    release();
    await Promise.all([first, second]);
    s.close();
  });

  it("validates filesystem-safe session ids", () => {
    expect(safeSessionId("abc_DEF-123")).toBe("abc_DEF-123");
    expect(safeSessionId("../../etc/passwd")).toBeNull();
    expect(safeSessionId("x".repeat(129))).toBeNull();
  });
});
