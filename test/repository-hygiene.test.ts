import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "vitest";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

test("the committed npm lockfile matches the package's direct dependency contract", () => {
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.deepEqual(lock.packages[""].devDependencies, pkg.devDependencies);
});

test("npm is the sole maintained source-install lockfile", () => {
  assert.ok(existsSync(new URL("package-lock.json", root)));
  for (const path of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", "bun.lock", "bun.lockb"]) {
    assert.equal(existsSync(new URL(path, root)), false, `Unexpected alternate package-manager state: ${path}`);
  }
  assert.match(read(".github/workflows/ci.yml"), /run: npm ci\b/);
});
