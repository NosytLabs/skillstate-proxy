import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
describe('documented state-patch boundaries', () => {
  it('documents empty patches as intentional no-ops', () => {
    assert.match(html, /state_patch.*\{\}/);
    assert.match(html, /valid no-op/);
  });
  it('distinguishes a null patch from null deletion of a nested key', () => {
    assert.match(html, /not null, an array or a scalar/);
    assert.match(html, /null patch value deletes its key/);
  });
  it('does not imply the separate hardening branch or npm package is released', () => {
    assert.match(html, /published npm package can contain different revisions/);
    assert.match(html, /not a hosted inference API/);
  });
  it('retains one heading and valid local fragment targets', () => {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((item) => item[1]);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
    for (const [, fragment] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(fragment));
  });
});
