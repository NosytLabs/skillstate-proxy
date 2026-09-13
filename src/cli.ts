#!/usr/bin/env node
import { startProxy, DEFAULT_CONFIG, type ProxyConfig } from "./proxy.js";
import { readFileSync, existsSync } from "node:fs";

class CliConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliConfigError";
  }
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function printHelp(): void {
  console.log(`
skillstate-proxy v${packageVersion()}

Drop-in SKILL.state proxy for long-horizon LLM agents.
Rewrites growing histories to (spec, structured state, latest observation).

USAGE
  skillstate [options]
  skillstate-proxy [options]

OPTIONS
  --help, -h          Show this help message
  --version, -v       Print package version
  --config <path>     JSON config file (auto-discovers ./skillstate.json)
  --port <number>     Listen port, 0-65535 (default 8789)
  --upstream <url>    Upstream HTTP(S) API base URL
  --schema <keys>     Comma-separated fixed state keys
  --verbose           Enable request metadata logging (never message bodies/keys)

ENVIRONMENT
  SKILLSTATE_UPSTREAM
  SKILLSTATE_API_KEY
  SKILLSTATE_PORT
  SKILLSTATE_SCHEMA
  SKILLSTATE_INITIAL_STATE
  SKILLSTATE_CONFIG
  SKILLSTATE_VERBOSE

ENDPOINTS
  POST   /v1/chat/completions
  POST   /v1/messages
  GET    /v1/models
  GET    /health
  GET    /state[?session=<sid>]
  DELETE /state?session=<sid>
  GET    /cost

SESSION CONTINUITY
  Send x-skillstate-session back on later requests. If omitted, the proxy creates
  a new random session id and returns it in the response header.

EXAMPLE
  SKILLSTATE_UPSTREAM=https://api.openai.com/v1 \\
  SKILLSTATE_API_KEY=sk-... \\
  skillstate

For more information: https://github.com/NosytLabs/skillstate-proxy
Paper: https://arxiv.org/abs/2608.26263
`);
}

type CliArgs = Partial<ProxyConfig> & { configPath?: string; exit?: "help" | "version" };

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new CliConfigError(`missing value for ${flag}`);
  return value;
}

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const cfg: CliArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "--help":
      case "-h":
        cfg.exit = "help";
        return cfg;
      case "--version":
      case "-v":
        cfg.exit = "version";
        return cfg;
      case "--config":
        cfg.configPath = requiredValue(args, ++i, "--config");
        break;
      case "--port": {
        const value = requiredValue(args, ++i, "--port");
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          throw new CliConfigError("port must be an integer between 0 and 65535");
        }
        cfg.listenPort = port;
        break;
      }
      case "--upstream": {
        const url = requiredValue(args, ++i, "--upstream");
        cfg.upstreams = [{ name: "cli", url, apiKey: process.env.SKILLSTATE_API_KEY, priority: 0 }];
        break;
      }
      case "--schema":
        cfg.schema = requiredValue(args, ++i, "--schema").split(",").map(s => s.trim()).filter(Boolean);
        break;
      case "--verbose":
        cfg.verbose = true;
        break;
      default:
        throw new CliConfigError(`unknown option: ${arg}. Run with --help for usage.`);
    }
  }
  return cfg;
}

function parseInitialState(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new CliConfigError("SKILLSTATE_INITIAL_STATE must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliConfigError("SKILLSTATE_INITIAL_STATE must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parsePort(raw: string, source: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new CliConfigError(`${source} must be an integer between 0 and 65535`);
  }
  return port;
}

export function loadConfig(cliArgs: CliArgs): Partial<ProxyConfig> {
  const explicitConfig = cliArgs.configPath ?? process.env.SKILLSTATE_CONFIG;
  const autoConfig = !explicitConfig && existsSync("skillstate.json") ? "skillstate.json" : undefined;
  const configPath = explicitConfig ?? autoConfig;

  if (explicitConfig && !existsSync(explicitConfig)) {
    throw new CliConfigError(`config file not found: ${explicitConfig}`);
  }

  let fileConfig: Partial<ProxyConfig> = {};
  if (configPath) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("top level must be an object");
      }
      fileConfig = parsed as Partial<ProxyConfig>;
    } catch (error: any) {
      throw new CliConfigError(`failed to parse config file ${configPath}: ${error?.message ?? String(error)}`);
    }
  }

  const envConfig: Partial<ProxyConfig> = {};
  if (process.env.SKILLSTATE_PORT !== undefined) envConfig.listenPort = parsePort(process.env.SKILLSTATE_PORT, "SKILLSTATE_PORT");
  if (process.env.SKILLSTATE_UPSTREAM) {
    envConfig.upstreams = [{
      name: "env",
      url: process.env.SKILLSTATE_UPSTREAM,
      apiKey: process.env.SKILLSTATE_API_KEY,
      priority: 0,
    }];
  }
  if (process.env.SKILLSTATE_SCHEMA !== undefined) {
    envConfig.schema = process.env.SKILLSTATE_SCHEMA.split(",").map(s => s.trim()).filter(Boolean);
  }
  if (process.env.SKILLSTATE_INITIAL_STATE !== undefined) {
    envConfig.initialState = parseInitialState(process.env.SKILLSTATE_INITIAL_STATE);
  }
  if (process.env.SKILLSTATE_VERBOSE !== undefined) {
    const raw = process.env.SKILLSTATE_VERBOSE.toLowerCase();
    if (!["0", "1", "false", "true"].includes(raw)) {
      throw new CliConfigError("SKILLSTATE_VERBOSE must be 0, 1, false, or true");
    }
    envConfig.verbose = raw === "1" || raw === "true";
  }

  const cliConfig = Object.fromEntries(
    Object.entries(cliArgs).filter(([key, value]) => value !== undefined && key !== "configPath" && key !== "exit"),
  ) as Partial<ProxyConfig>;

  // Exact precedence: defaults < config file < environment < CLI.
  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...envConfig,
    ...cliConfig,
  };
}

async function main(): Promise<void> {
  try {
    const cliArgs = parseArgs(process.argv);
    if (cliArgs.exit === "help") {
      printHelp();
      return;
    }
    if (cliArgs.exit === "version") {
      console.log(packageVersion());
      return;
    }

    const config = loadConfig(cliArgs);
    const proxy = await startProxy(config);
    console.log(`[skillstate] ready. Point OpenAI-compatible clients at http://127.0.0.1:${proxy.port}/v1`);

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n[skillstate] ${signal}; shutting down...`);
      try {
        await proxy.close();
      } catch (error: any) {
        console.error(`[skillstate] shutdown error: ${error?.message ?? String(error)}`);
        process.exitCode = 1;
      }
    };
    process.once("SIGINT", () => { void shutdown("SIGINT"); });
    process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    console.error(`[skillstate] configuration error: ${message}`);
    process.exitCode = 1;
  }
}

void main();
