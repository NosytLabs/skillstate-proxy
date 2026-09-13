import {
  existsSync,
  mkdirSync,
  readdirSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { StateSession, StateValueKind } from "./state.js";
import { serializeState, DEFAULT_MAX_STATE_BYTES, byteLimit } from "./json-state.js";

export interface SessionStoreOptions {
  stateDir: string;
  ttlMs: number;
  maxStateBytes?: number;
  maxSessionBytes?: number;
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
  if (!Number.isSafeInteger(value.step) || (value.step as number) < 0) return false;
  if (typeof value.initialized !== "boolean") return false;
  if (value.stateTypes !== undefined) {
    if (!plainObject(value.stateTypes) || !Object.values(value.stateTypes).every(validStateKind)) return false;
  }
  return true;
}

export class SessionStore {
  private readonly stateDir: string;
  private readonly ttlMs: number;
  private readonly maxStateBytes: number;
  private readonly maxSessionBytes: number;
  private readonly cache = new Map<string, Cached>();
  private readonly lockTails = new Map<string, Promise<void>>();
  private readonly gcTimer: ReturnType<typeof setInterval>;

  constructor(options: SessionStoreOptions) {
    this.stateDir = options.stateDir;
    this.ttlMs = options.ttlMs;
    this.maxStateBytes = byteLimit(options.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES, "maxStateBytes");
    this.maxSessionBytes = byteLimit(options.maxSessionBytes ?? this.maxStateBytes + 1_048_576, "maxSessionBytes");
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
        return structuredClone(cached.session);
      }
      this.cache.delete(sid);
    }

    const file = this.path(sid);
    let fd: number | undefined;
    try {
      const before = lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink()) return null;
      // Reject final-component links where supported; parent directory remains trusted.
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const info = fstatSync(fd);
      if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size > this.maxSessionBytes) return null;
      if (now - info.mtimeMs > this.ttlMs) return null;
      const chunks: Buffer[] = [];
      const chunk = Buffer.alloc(Math.min(65_536, this.maxSessionBytes + 1));
      let total = 0;
      while (true) {
        const count = readSync(fd, chunk, 0, Math.min(chunk.length, this.maxSessionBytes - total + 1), null);
        if (!count) break;
        total += count;
        if (total > this.maxSessionBytes) return null;
        chunks.push(Buffer.from(chunk.subarray(0, count)));
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
      const parsed: unknown = JSON.parse(text);
      this.encode(parsed);
      const accepted = parsed as StateSession;
      this.cache.set(sid, { session: accepted, lastAccess: now });
      return structuredClone(accepted);
    } catch {
      // Invalid/oversized/unreadable files are not deleted as a side effect of a read.
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private encode(session: unknown): string {
    const encoded = serializeState(session, this.maxSessionBytes, "session");
    if (!validSession(session)) throw new Error("invalid session shape");
    serializeState(session.state, this.maxStateBytes, "stored state");
    if (new Set(session.schema).size !== session.schema.length || (session.schema.length && Object.keys(session.state).some(key => !session.schema.includes(key)))) {
      throw new Error("stored state does not match its schema");
    }
    return encoded;
  }

  save(id: string, session: StateSession): void {
    const sid = safeSessionId(id);
    if (!sid) throw new Error("invalid session id");
    const encoded = this.encode(session);
    const accepted: StateSession = JSON.parse(encoded);
    mkdirSync(this.stateDir, { recursive: true });
    const target = this.path(sid);
    const temp = join(this.stateDir, `.${sid}.tmp-${process.pid}-${randomUUID()}`);
    try {
      writeFileSync(temp, encoded, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temp, target);
    } finally {
      if (existsSync(temp)) {
        try { unlinkSync(temp); } catch { /* best effort */ }
      }
    }
    this.cache.set(sid, { session: accepted, lastAccess: Date.now() });
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
