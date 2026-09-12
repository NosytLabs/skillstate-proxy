import { describe, expect, it } from 'vitest';
import { extractDelta } from '../src/state.js';

describe('state encoding precedence', () => {
  const noop = '```json\n{"state_patch":{},"action":"continue"}\n```';

  it.each([
    `${noop}\nSTATE: {"step":99}`,
    `STATE: {"step":99}\n${noop}`,
    `${noop}\n@state {"step":99}`,
  ])('preserves a valid fenced no-op despite a separate legacy marker', (text) => {
    const result = extractDelta(text);
    expect(result.delta).toEqual({});
    expect(result.action).toBe('continue');
    expect(result.valid).toBe(true);
    expect(result.format).toBe('paper');
  });

  it('preserves an empty legacy fence ahead of a lower-priority inline marker', () => {
    const result = extractDelta('```state\n{}\n```\nSTATE: {"step":99}');
    expect(result.delta).toEqual({});
    expect(result.valid).toBe(false);
    expect(result.format).toBe('legacy');
  });

  it('retains the existing nonempty fenced priority', () => {
    const result = extractDelta('```json\n{"state_patch":{"step":1},"action":"continue"}\n```\nSTATE: {"step":99}');
    expect(result.delta).toEqual({ step: 1 });
    expect(result.format).toBe('paper');
  });

  it('still reads inline legacy output when no valid fence exists', () => {
    const result = extractDelta('```json\nnot-json\n```\nSTATE: {"step":2}');
    expect(result.delta).toEqual({ step: 2 });
    expect(result.valid).toBe(false);
    expect(result.format).toBe('legacy');
  });

  it('still accepts a whole-output no-op envelope', () => {
    const result = extractDelta('{"state_patch":{},"action":"continue"}');
    expect(result.delta).toEqual({});
    expect(result.action).toBe('continue');
    expect(result.valid).toBe(true);
    expect(result.format).toBe('paper');
  });
});
