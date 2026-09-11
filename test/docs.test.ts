import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const css = readFileSync(new URL('../docs/styles.css', import.meta.url), 'utf8');

describe('documentation contracts', () => {
  it('does not present historical numbers or universal compatibility as guarantees', () => {
    for (const text of [html, readme]) {
      expect(text).not.toMatch(/cuts prompt tokens 60[–-]95%|accuracy stays at 0\.94|constant response time regardless|works with any model|33(?:%2F|\/)33%20passing/i);
      expect(text).toMatch(/workload/i);
      expect(text).toMatch(/not a hosted/i);
      expect(text).toMatch(/not a lossless/i);
    }
  });
  it('preserves the public install, API and configuration anchors without broken local links', () => {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['install', 'api', 'config']) expect(ids).toContain(id);
    for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) expect(ids).toContain(target);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });
  it('provides a keyboard skip link and labels scrollable reference tables', () => {
    expect(html).toContain('href="#main-content"');
    expect(html).toMatch(/<main\b[^>]*id="main-content"/);
    const tables = html.match(/<table\b/g) ?? [];
    const regions = html.match(/<div class="table-wrap" tabindex="0" role="region" aria-label="[^"]+">\s*<table\b/g) ?? [];
    expect(tables.length).toBeGreaterThan(0);
    expect(regions.length).toBe(tables.length);
  });
  it('includes visible keyboard focus and a reduced-motion alternative', () => {
    expect(css).toContain(':focus-visible');
    expect(css).toContain('prefers-reduced-motion');
    expect(css).not.toMatch(/overflow-x:\s*hidden/);
  });
});
