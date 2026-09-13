import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { StateSession, StateValueKind } from "./state.js";

export interface SessionStoreOptions {
  stateDir: string;
  ttlMs: number;
}

type Cached = { session: StateSession; lastAccess: number };

export function safeSessionId(id: string): string | null {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validStateKind(value: unknown): value is StateValueKind {
  return value === "string" || value === "number" || value === "boolean" || value === "array" || value === "object";
}

function validSession(value: unknown): value is StateSession {
  if (!plainObject(value)) return false;
  if (typeof value.spec !== "string") return false;
  if (!plainObject(value.state)) return false;
  if (!Array.isArray(value.schema) || !value.schema.every(v => typeof v === "string")) return false;
  if (!Number.isInteger(value.step) || (value.step as number) < 0) return false;
  if (typeof value.initialized !== "boolean") return false;
  if (value.stateTypes !== undefined) {
    if (!plainObject(value.stateTypes) || !Object.values(value.stateTypes).every(validStateKind)) return false;
  }
  return true;
}

export class SessionStore {
  private readonly stateDir: string;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, Cached>();
  private readonly lockTails = new Map<string, Promise<void>>();
  private readonly gcTimer: ReturnType<typeof setInterval>;

  constructor(options: SessionStoreOptions) {
    this.stateDir = options.stateDir;
    this.ttlMs = options.ttlMs;
    mkdirSync(this.stateDir, { recursive: true });
    this.gcTimer = setInterval(() => this.gcMemory(), Math.min(5 * 60_000, Math.max(1000, this.ttlMs)));
    this.gcTimer.unref();
  }

  private path(id: string): string {
    return join(this.stateDir, `${id}.json`);
  }

  private gcMemory(): void {
    const now = Date.now();
    for (const [id, entry] of this.cache) {
      if (now - entry.lastAccess > this.ttlMs) this.cache.delete(id);
    }
  }

  get(id: string): StateSession | null {
    const sid = safeSessionId(id);
    if (!sid) return null;
    const now = Date.now();
    const cached = this.cache.get(sid);
    if (cached) {
      if (now - cached.lastAccess <= this.ttlMs) {
        cached.lastAccess = now;
        return cached.session;
      }
      this.cache.delete(sid);
    }

    const file = this.path(sid);
    if (!existsSync(file)) return null;
    try {
      if (now - statSync(file).mtimeMs > this.ttlMs) {
        unlinkSync(file);
        return null;
      }
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!validSession(parsed)) {
        try { unlinkSync(file); } catch { /* best effort */ }
        return null;
      }
      this.cache.set(sid, { session: parsed, lastAccess: now });
      return parsed;
    } catch {
      try { unlinkSync(file); } catch { /* best effort */ }
      return null;
    }
  }

  save(id: string, session: StateSession): void {
    const sid = safeSessionId(id);
    if (!sid) throw new Error("invalid session id");
    if (!validSession(session)) throw new Error("invalid session shape");
    mkdirSync(this.stateDir, { recursive: true });
    const target = this.path(sid);
    const temp = join(this.stateDir, `.${sid}.tmp-${process.pid}-${randomUUID()}`);
    try {
      writeFileSync(temp, JSON.stringify(session), "utf8");
      renameSync(temp, target);
    } finally {
      if (existsSync(temp)) {
        try { unlinkSync(temp); } catch { /* best effort */ }
      }
    }
    this.cache.set(sid, { session, lastAccess: Date.now() });
  }

  delete(id: string): boolean {
    const sid = safeSessionId(id);
    if (!sid) return false;
    this.cache.delete(sid);
    const file = this.path(sid);
    if (!existsSync(file)) return false;
    try {
      unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  }

  list(): string[] {
    const ids = new Set<string>(this.cache.keys());
    try {
      for (const name of readdirSync(this.stateDir)) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -5);
        if (safeSessionId(id)) ids.add(id);
      }
    } catch {
      // state directory may be concurrently unavailable; return cached ids
    }
    return [...ids].sort();
  }

  async withSessionLock<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
    const sid = safeSessionId(id);
    if (!sid) throw new Error("invalid session id");
    const previous = this.lockTails.get(sid) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    this.lockTails.set(sid, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.lockTails.get(sid) === tail) this.lockTails.delete(sid);
    }
  }

  close(): void {
    clearInterval(this.gcTimer);
    this.cache.clear();
    this.lockTails.clear();
  }
}
