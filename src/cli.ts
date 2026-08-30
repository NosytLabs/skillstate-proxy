#!/usr/bin/env node
import { startProxy, DEFAULT_CONFIG, type ProxyConfig } from "./proxy.js";
import { readFileSync, existsSync } from "node:fs";

const VERSION = "0.1.0";

function printHelp(): void {
  console.log(`
skillstate-proxy v${VERSION}

Drop-in token-savings proxy for long-horizon LLM agents.
Cuts prompt tokens 60-95% via SKILL.state (arXiv:2608.26263, EMNLP 2026).

USAGE
  skillstate [options]

OPTIONS
  --help, -h          Show this help message
  --version, -v       Print version
  --config <path>     Path to JSON config file (default: skillstate.json in CWD)
  --port <number>     Listen port (default: 8789, env: SKILLSTATE_PORT)
  --upstream <url>    Upstream API base URL (env: SKILLSTATE_UPSTREAM)
  --schema <keys>     Comma-separated state keys (env: SKILLSTATE_SCHEMA)
  --verbose           Enable verbose request logging

ENVIRONMENT VARIABLES
  SKILLSTATE_UPSTREAM         Upstream API base URL (default: https://api.openai.com/v1)
  SKILLSTATE_API_KEY          API key for the upstream
  SKILLSTATE_PORT             Listen port (default: 8789)
  SKILLSTATE_SCHEMA           Comma-separated state keys (e.g. step,notes,flags)
  SKILLSTATE_INITIAL_STATE    JSON string of initial state
  SKILLSTATE_CONFIG           Path to a JSON config file
  SKILLSTATE_VERBOSE          Enable verbose request logging (set to "1")

ENDPOINTS (served by the proxy)
  POST /v1/chat/completions   OpenAI-compatible chat completions
  POST /v1/messages           Anthropic-compatible messages (auto-translated)
  GET  /v1/models             List models (proxied to upstream)
  GET  /health                Upstream circuit breaker status
  GET  /state                 List sessions (or ?session=<sid> to inspect)
  DELETE /state?session=<sid> Reset a session
  GET  /cost                  24h spend summary

EXAMPLES
  # Point at OpenAI
  SKILLSTATE_UPSTREAM=https://api.openai.com/v1 \\
  SKILLSTATE_API_KEY=sk-... \\
  skillstate

  # Point at Venice (cheap open models)
  SKILLSTATE_UPSTREAM=https://api.venice.ai/api/v1 \\
  SKILLSTATE_API_KEY=... \\
  skillstate

  # Point at local Ollama
  SKILLSTATE_UPSTREAM=http://localhost:11434/v1 \\
  skillstate

  # Use a config file
  skillstate --config skillstate.json

  # Call the proxy
  curl http://127.0.0.1:8789/v1/chat/completions \\
    -H 'content-type: application/json' \\
    -d '{"model":"gpt-4o","messages":[{"role":"system","content":"TASK: track state"},{"role":"user","content":"go"}]}'

CONFIG FILE (skillstate.json)
  {
    "listenPort": 8789,
    "upstreams": [
      { "name": "openai", "url": "https://api.openai.com/v1", "apiKey": "sk-...", "priority": 0 }
    ],
    "schema": ["step", "notes", "flags"],
    "initialState": { "step": 0 },
    "maxRetries": 2,
    "cors": true
  }

For more information: https://github.com/NosytLabs/skillstate-proxy
Paper: https://arxiv.org/abs/2608.26263
`);
}

function parseArgs(argv: string[]): Partial<ProxyConfig> & { configPath?: string } {
  const args = argv.slice(2);
  const cfg: Partial<ProxyConfig> & { configPath?: string } = {};
  let i = 0;

  while (i < args.length) {
    const a = args[i];
    switch (a) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      case "--version":
      case "-v":
        console.log(VERSION);
        process.exit(0);
      case "--config":
        cfg.configPath = args[++i];
        break;
      case "--port":
        cfg.listenPort = Number(args[++i]);
        break;
      case "--upstream": {
        const url = args[++i];
        const key = process.env.SKILLSTATE_API_KEY;
        cfg.upstreams = [{ name: "cli", url, apiKey: key, priority: 0 }];
        break;
      }
      case "--schema":
        cfg.schema = args[++i]?.split(",").map(s => s.trim()).filter(Boolean);
        break;
      case "--verbose":
        cfg.verbose = true;
        break;
      default:
        console.error(`[skillstate] unknown option: ${a}`);
        console.error("Run with --help for usage.");
        process.exit(1);
    }
    i++;
  }

  return cfg;
}

function loadConfig(cliArgs: Partial<ProxyConfig> & { configPath?: string }): Partial<ProxyConfig> {
  // CLI args > config file > env vars > defaults
  const cfgPath = cliArgs.configPath
    ?? process.env.SKILLSTATE_CONFIG
    ?? (existsSync("skillstate.json") ? "skillstate.json" : undefined);

  let fileCfg: Partial<ProxyConfig> = {};
  if (cfgPath && existsSync(cfgPath)) {
    try {
      fileCfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    } catch (err: any) {
      console.error(`[skillstate] failed to parse config file: ${cfgPath}`);
      console.error(err?.message ?? err);
      process.exit(1);
    }
  }

  const envUpstreams = process.env.SKILLSTATE_UPSTREAM
    ? [{ name: "env", url: process.env.SKILLSTATE_UPSTREAM, apiKey: process.env.SKILLSTATE_API_KEY, priority: 0 }]
    : undefined;

  const envCfg: Partial<ProxyConfig> = {
    listenPort: process.env.SKILLSTATE_PORT ? Number(process.env.SKILLSTATE_PORT) : undefined,
    upstreams: envUpstreams,
    schema: process.env.SKILLSTATE_SCHEMA ? process.env.SKILLSTATE_SCHEMA.split(",").map(s => s.trim()).filter(Boolean) : undefined,
    initialState: process.env.SKILLSTATE_INITIAL_STATE ? JSON.parse(process.env.SKILLSTATE_INITIAL_STATE) : undefined,
    verbose: process.env.SKILLSTATE_VERBOSE === "1" || process.env.SKILLSTATE_VERBOSE === "true",
  };

  // Merge: defaults < file < env < cli
  const merged: Partial<ProxyConfig> = {
    ...DEFAULT_CONFIG,
    ...fileCfg,
    ...Object.fromEntries(Object.entries(envCfg).filter(([, v]) => v !== undefined)),
    ...Object.fromEntries(Object.entries(cliArgs).filter(([k, v]) => v !== undefined && k !== "configPath")),
  };

  return merged;
}

const cliArgs = parseArgs(process.argv);
const cfg = loadConfig(cliArgs);

startProxy(cfg).then(({ port, close }) => {
  console.log(`[skillstate] ready. Point OpenAI-compatible clients at http://127.0.0.1:${port}`);

  const shutdown = () => {
    console.log("\n[skillstate] shutting down…");
    close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
});
