import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
const cli = join(process.cwd(), "src", "cli.ts");
const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const env = { ...process.env } as Record<string, string | undefined>;
  for (const key of Object.keys(env)) if (key.startsWith("SKILLSTATE_")) delete env[key];
  Object.assign(env, extraEnv);
  return spawnSync(tsx, [cli, ...args], { encoding: "utf8", env: env as NodeJS.ProcessEnv, timeout: 1500 });
}

describe("CLI validation", () => {
  it("reads --version from package metadata", () => {
    const r = run(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it("prints help without starting the server", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("skillstate-proxy");
    expect(r.stdout).toContain("--config");
  });

  it("rejects a missing option value", () => {
    const r = run(["--port"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing value.*--port/i);
  });

  it("rejects an invalid port concisely", () => {
    const r = run(["--port", "-1"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/configuration error.*port/i);
    expect(r.stderr).not.toContain("at parseArgs");
  });

  it("rejects an explicitly requested missing config instead of silently starting", () => {
    const r = run(["--config", "/tmp/definitely-no-skillstate-config-123456.json"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/configuration error.*config.*not found/i);
  });

  it("rejects malformed SKILLSTATE_INITIAL_STATE concisely", () => {
    const r = run(["--version-is-not-used"], { SKILLSTATE_INITIAL_STATE: "{bad" });
    // Unknown option is evaluated first; exercise env parsing with a valid CLI option path instead.
    const envResult = run(["--port", "0"], { SKILLSTATE_INITIAL_STATE: "{bad" });
    expect(r.status).toBe(1);
    expect(envResult.status).toBe(1);
    expect(envResult.stderr).toMatch(/configuration error.*SKILLSTATE_INITIAL_STATE/i);
    expect(envResult.stderr).not.toContain("JSON.parse");
  });

  it("rejects an invalid upstream URL before binding", () => {
    const r = run(["--upstream", "not-a-url", "--port", "0"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/configuration error.*upstream/i);
  });
});
