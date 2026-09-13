/** Validate plain JSON data before encoding it, without calling getters/toJSON.
 * This is a serialization boundary, not a sandbox for hostile JavaScript proxies.
 */
export const DEFAULT_MAX_STATE_BYTES = 65_536;
export const RESERVED_STATE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function byteLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function serializeState(value: unknown, maxBytes: number, label = 'state'): string {
  byteLimit(maxBytes, 'byte limit');
  if (!isPlainRecord(value)) throw new Error(`${label} must be a plain JSON object`);
  const ancestors = new Set<object>();
  let bytes = 0;
  const fail = (reason: string): never => { throw new Error(`${label}: ${reason}`); };
  const add = (count: number) => {
    bytes += count;
    if (bytes > maxBytes) fail(`exceeds byte limit (${maxBytes})`);
  };
  const quoted = (text: string) => {
    if (text.length > maxBytes - bytes) fail(`exceeds byte limit (${maxBytes})`);
    add(Buffer.byteLength(JSON.stringify(text), 'utf8'));
  };
  const walk = (item: unknown, depth: number): void => {
    if (depth > 64) fail('exceeds nesting limit (64)');
    if (item === null) { add(4); return; }
    if (typeof item === 'string') { quoted(item); return; }
    if (typeof item === 'boolean') { add(item ? 4 : 5); return; }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail('numbers must be finite');
      add(String(item).length); return;
    }
    if (typeof item !== 'object') fail('contains a non-JSON value');
    const object = item as object;
    const array = Array.isArray(object);
    if (!array && !isPlainRecord(object)) fail('contains a non-plain object');
    if (ancestors.has(object)) fail('contains a cycle');
    ancestors.add(object);
    try {
      const keys = Reflect.ownKeys(object);
      if (array) {
        const list = object as unknown[];
        if (list.length > maxBytes || keys.length !== list.length + 1) fail('array must be dense and have no extra properties');
        add(2);
        for (let i = 0; i < list.length; i++) {
          const entry = Object.getOwnPropertyDescriptor(object, String(i));
          if (!entry || !('value' in entry) || !entry.enumerable) fail('array entries must be data properties');
          if (i) add(1);
          walk(entry!.value, depth + 1);
        }
      } else {
        add(2);
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          if (typeof key !== 'string' || RESERVED_STATE_KEYS.has(key)) fail('contains a reserved or symbol key');
          const entry = Object.getOwnPropertyDescriptor(object, key!);
          if (!entry || !('value' in entry) || !entry.enumerable) fail('object entries must be enumerable data properties');
          if (i) add(1);
          quoted(key as string); add(1);
          walk(entry!.value, depth + 1);
        }
      }
    } finally { ancestors.delete(object); }
  };
  walk(value, 0);
  return JSON.stringify(value);
}
