import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { extractDelta } from '../src/state.js';

const fence = (body: unknown, language = 'json') => '```' + language + '\n' + JSON.stringify(body) + '\n```';

describe('state update extraction priority and shape', () => {
  it('keeps an explicit empty paper patch instead of applying a later legacy marker', () => {
    const output = fence({ state_patch: {}, action: 'finish' }) + '\nSTATE: {"unexpected": true}';
    const result = extractDelta(output);
    assert.deepEqual(result.delta, {});
    assert.equal(result.valid, true);
    assert.equal(result.format, 'paper');
    assert.equal(result.action, 'finish');
  });
  it('keeps an empty legacy fence ahead of inline fallback', () => {
    const result = extractDelta(fence({}) + '\n@state {"unexpected": true}');
    assert.deepEqual(result.delta, {});
    assert.equal(result.valid, false);
    assert.equal(result.format, 'legacy');
  });
  for (const alias of ['state_patch', 'statePatch', 'delta', 'state', 'sigma']) {
    it(`retains no-op and action for supported alias ${alias}`, () => {
      const result = extractDelta(fence({ [alias]: {}, command: 'done' }) + '\nDELTA: {"shadow": 1}');
      assert.deepEqual(result.delta, {});
      assert.equal(result.valid, true);
      assert.equal(result.format, 'paper');
      assert.equal(result.action, 'done');
    });
  }
  for (const value of [[], [1], null, 1, 'bad', false]) {
    for (const encoding of ['whole', 'fenced']) {
      it(`rejects ${encoding} explicit non-object patch ${JSON.stringify(value)}`, () => {
        const body = { state_patch: value, action: 'do-not-accept' };
        const result = extractDelta(encoding === 'fenced' ? fence(body) : JSON.stringify(body));
        assert.deepEqual(result.delta, {});
        assert.equal(result.valid, false);
        assert.equal(result.format, 'none');
        assert.equal(result.action, undefined);
      });
    }
  }
  it('does not switch aliases when an explicit preferred patch is invalid', () => {
    const result = extractDelta(fence({ state_patch: null, delta: { unexpected: 1 } }));
    assert.equal(result.valid, false);
    assert.deepEqual(result.delta, {});
  });
  it('prefers a valid wrapped patch over an earlier legacy fenced example', () => {
    const result = extractDelta(fence({ example: 1 }) + '\n' + fence({state_patch: {step:2}, action:'run'}));
    assert.deepEqual(result.delta, {step:2});
    assert.equal(result.format, 'paper');
    assert.equal(result.action, 'run');
  });
  it('can find a valid wrapped patch after an unrelated invalid code block', () => {
    const result = extractDelta('```python\nprint(1)\n```\n' + fence({state_patch:{step:3}, action:'run'}));
    assert.deepEqual(result.delta, {step:3});
    assert.equal(result.valid, true);
  });
  it('keeps the first valid paper patch and does not combine competing actions', () => {
    const result = extractDelta(fence({state_patch:{step:1}, action:'first'}) + '\n' + fence({state_patch:{step:2},action:'second'}));
    assert.deepEqual(result.delta, {step:1});
    assert.equal(result.action, 'first');
  });
  it('supports whole JSON, inline legacy, nested deletion data and no-op', () => {
    assert.deepEqual(extractDelta('{"state_patch":{"nested":{"x":null}}}').delta,{nested:{x:null}});
    assert.deepEqual(extractDelta('@state {"a":1}').delta,{a:1});
    assert.equal(extractDelta('{"state_patch":{}}').valid,true);
    assert.equal(extractDelta('not JSON').valid,false);
  });
  it('removes only the chosen structured fence from reasoning', () => {
    const body = fence({state_patch:{step:1},action:'run'});
    assert.equal(extractDelta('before\n' + body + '\nafter').reasoning, 'before\n\nafter');
  });
});
