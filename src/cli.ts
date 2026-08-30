#!/usr/bin/env node
import { startProxy, DEFAULT_CONFIG, type ProxyConfig } from "./proxy.js";
import { readFileSync, existsSync } from "node:fs";

function loadConfig(): Partial<ProxyConfig> {
  const cfgPath = process.env.SKILLSTATE_CONFIG;
  if (cfgPath && existsSync(cfgPath)) {
    try {
      return JSON.parse(readFileSync(cfgPath, "utf-8"));
    } catch {
      console.error(`[skillstate] failed to parse config file: ${cfgPath}`);
    }
  }
  const upstreams = process.env.SKILLSTATE_UPSTREAM
    ? [{ name: "env", url: process.env.SKILLSTATE_UPSTREAM, apiKey: process.env.SKILLSTATE_API_KEY, priority: 0 }]
    : DEFAULT_CONFIG.upstreams;
  return {
    listenPort: process.env.SKILLSTATE_PORT ? Number(process.env.SKILLSTATE_PORT) : DEFAULT_CONFIG.listenPort,
    upstreams,
    schema: process.env.SKILLSTATE_SCHEMA ? process.env.SKILLSTATE_SCHEMA.split(",") : [],
    initialState: process.env.SKILLSTATE_INITIAL_STATE ? JSON.parse(process.env.SKILLSTATE_INITIAL_STATE) : {},
  };
}

const cfg = loadConfig();

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
