import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfigValues } from '../src/config.js';
import { DEFAULT_CONFIG, startProxy } from '../src/proxy.js';
import { newSession, validateTransition } from '../src/state.js';
import { SessionStore } from '../src/session-store.js';

const stores: SessionStore[] = [];
const dirs: string[] = [];
function store(extra: Record<string, number> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'skillstate-data-')); dirs.push(dir);
  const instance = new SessionStore({ stateDir: dir, ttlMs: 60_000, ...extra }); stores.push(instance);
  return { dir, instance };
}
afterEach(() => { vi.restoreAllMocks(); for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const config = (changes: Record<string, unknown>) => ({ ...DEFAULT_CONFIG, ...changes });
const session = () => newSession('synthetic spec', { data: { count: 1 } }, ['data']);

const badValues: [string, () => unknown][] = [
  ['NaN', () => NaN], ['infinity', () => Infinity], ['negative infinity', () => -Infinity],
  ['undefined', () => undefined], ['function', () => () => 1], ['bigint', () => 1n],
  ['date', () => new Date(0)], ['map', () => new Map()], ['sparse array', () => new Array(1)],
  ['undefined array entry', () => [undefined]],
  ['cycle', () => { const data: any = {}; data.self = data; return data; }],
  ['prototype key', () => JSON.parse('{"__proto__":{"poisoned":true}}')],
  ['constructor key', () => JSON.parse('{"constructor":{"prototype":{"poisoned":true}}}')],
  ['symbol key', () => ({ [Symbol('hidden')]: 1 })],
  ['custom prototype', () => Object.assign(Object.create({ hidden: true }), { count: 1 })],
];

describe('strict state data', () => {
  for (const [name, make] of badValues) {
    it(`rejects ${name} without changing a session`, () => {
      const current = session(); const before = structuredClone(current);
      const checked = validateTransition(current, { state_patch: { data: { payload: make() } }, action: 'done' });
      expect(checked.ok).toBe(false);
      expect(checked.candidateState).toBeUndefined(); expect(current).toEqual(before);
    });
    it(`rejects initial ${name} before startup`, () => {
      expect(() => normalizeConfigValues(config({ initialState: { data: make() }, schema: ['data'] }))).toThrow();
    });
  }
  it('rejects accessors without executing their getter', () => {
    const getter = vi.fn(() => 7); const value = Object.defineProperty({}, 'count', { enumerable: true, get: getter });
    expect(validateTransition(session(), { state_patch: { data: value }, action: 'done' }).ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
  it('does not evaluate getters on the transition envelope', () => {
    const getter = vi.fn(() => ({ data: { count: 2 } }));
    const envelope = Object.defineProperty({ action: 'done' }, 'state_patch', { enumerable: true, get: getter });
    expect(validateTransition(session(), envelope as any).ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
  it('bounds nested objects without a stack overflow', () => {
    let value: unknown = 1; for (let i = 0; i < 100; i++) value = { child: value };
    expect(validateTransition(session(), { state_patch: { data: value }, action: 'done' }).ok).toBe(false);
  });
  it('allows ordinary JSON data, shared references and null deletion inside state maps', () => {
    const shared = { x: 'same' };
    const checked = validateTransition(session(), { state_patch: { data: { count: null, list: [null, true, 0, '✅'], a: shared, b: shared } }, action: '' });
    expect(checked.ok).toBe(true); expect(checked.candidateState!.data).not.toHaveProperty('count');
  });
  it('applies UTF-8 byte caps to initial state', () => {
    expect(() => normalizeConfigValues(config({ initialState: { data: '😀'.repeat(30) }, schema: ['data'], maxStateBytes: 64 }))).toThrow(/initialState|state|bytes/i);
  });
  it('rejects reserved schema keys', () => {
    expect(() => normalizeConfigValues(config({ schema: ['__proto__'] }))).toThrow();
  });
  it('rejects initial keys outside an explicitly declared schema', () => {
    expect(() => normalizeConfigValues(config({ initialState: { unexpected: 1 }, schema: ['allowed'] }))).toThrow();
  });
  it('rejects fractional byte limits before opening the server', () => {
    expect(() => normalizeConfigValues(config({ maxStateBytes: 1.5 }))).toThrow();
  });
  it('detaches the normalized initial state from its caller', () => {
    const initialState = { data: { count: 1 } }; const checked = normalizeConfigValues(config({ initialState, schema: ['data'] }));
    initialState.data.count = 99; expect(checked.initialState.data).toEqual({ count: 1 });
  });
  it('rejects oversize initial data before creating any session or listening', async () => {
    const { dir } = store(); let proxy;
    try {
      await expect((async () => { proxy = await startProxy({ listenPort: 0, stateDir: dir, costLedgerPath: join(dir, 'cost.jsonl'), initialState: { data: 'x'.repeat(512) }, schema: ['data'], maxStateBytes: 64 }); })()).rejects.toThrow();
    } finally { await proxy?.close(); }
  });
});

describe('saved-session boundaries', () => {
  it('rejects oversized stored state while preserving the file for diagnosis', () => {
    const { dir, instance } = store({ maxStateBytes: 64 });
    const path = join(dir, 'large.json'); writeFileSync(path, JSON.stringify({ ...session(), state: { data: 'x'.repeat(128) } }));
    expect(instance.get('large')).toBeNull(); expect(statSync(path).isFile()).toBe(true);
  });
  it('rejects oversized session records before decoding them', () => {
    const { dir, instance } = store({ maxSessionBytes: 256 });
    writeFileSync(join(dir, 'large.json'), JSON.stringify({ ...session(), spec: 'x'.repeat(1024) }));
    expect(instance.get('large')).toBeNull();
  });
  it('does not follow final-component symbolic links to session files', () => {
    const { dir, instance } = store(); const outside = join(dir, 'outside.txt');
    writeFileSync(outside, JSON.stringify(session())); symlinkSync(outside, join(dir, 'linked.json'));
    expect(instance.get('linked')).toBeNull(); expect(JSON.parse(readFileSync(outside, 'utf8')).state.data.count).toBe(1);
  });
  it('rejects invalid UTF-8 rather than silently substituting a character', () => {
    const { dir, instance } = store(); const body = Buffer.from(JSON.stringify(session()));
    const offset = body.indexOf('synthetic'); body[offset] = 255;
    writeFileSync(join(dir, 'encoding.json'), body); expect(instance.get('encoding')).toBeNull();
  });
  it('rejects unsafe step counters', () => {
    const { dir, instance } = store(); writeFileSync(join(dir, 'counter.json'), JSON.stringify({ ...session(), step: Number.MAX_SAFE_INTEGER + 1 }));
    expect(instance.get('counter')).toBeNull();
  });
  it('rejects persisted prototype-shaped data', () => {
    const { dir, instance } = store(); const saved = session(); saved.state = JSON.parse('{"__proto__":{"x":1}}');
    writeFileSync(join(dir, 'unsafe.json'), JSON.stringify(saved)); expect(instance.get('unsafe')).toBeNull();
  });
  it('does not expose a mutable reference to cached session state', () => {
    const { instance } = store(); const original = session(); instance.save('copy', original);
    (original.state.data as any).count = 50;
    const read = instance.get('copy')!; expect((read.state.data as any).count).toBe(1);
    (read.state.data as any).count = 99; expect((instance.get('copy')!.state.data as any).count).toBe(1);
  });
  it('rejects invalid saves without changing the last valid file or cache', () => {
    const { dir, instance } = store({ maxStateBytes: 64 }); instance.save('safe', session());
    const before = readFileSync(join(dir, 'safe.json'), 'utf8');
    expect(() => instance.save('safe', { ...session(), state: { data: 'x'.repeat(128) } })).toThrow();
    expect(readFileSync(join(dir, 'safe.json'), 'utf8')).toBe(before);
    expect(instance.get('safe')!.state).toEqual(session().state);
  });
  it('round trips a valid no-op session through a new store', () => {
    const { dir, instance } = store(); const s = session(); instance.save('valid', s); instance.close();
    const restored = new SessionStore({ stateDir: dir, ttlMs: 60_000 }); stores.push(restored);
    expect(restored.get('valid')).toEqual(s);
  });
});
