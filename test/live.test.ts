import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startProxy, type ProxyConfig } from "../src/proxy.js";
import { existsSync, readFileSync } from "node:fs";

/**
 * LIVE integration test. Only runs if SKILLSTATE_LIVE=1 and a tokenrouter key
 * is present in the env (TOKENROUTER_API_KEY). Skips otherwise so CI is free.
 */
const LIVE = process.env.SKILLSTATE_LIVE === "1";
const API_KEY = process.env.TOKENROUTER_API_KEY;
const BASE_URL = process.env.TOKENROUTER_BASE_URL || "https://api.tokenrouter.com/v1";
let proxyStateDir = "/tmp/skillstate-live";

describe.skipIf(!LIVE || !API_KEY)("live: proxy → tokenrouter (real model call)", () => {
  let port = 0;
  let close: () => void;
  let proxyStateDir = "/tmp/skillstate-live";

  beforeAll(async () => {
    proxyStateDir = "/tmp/skillstate-live-" + Date.now();
    const cfg: Partial<ProxyConfig> = {
      listenPort: 8799,
      upstreams: [{ name: "tokenrouter", url: BASE_URL, apiKey: API_KEY, priority: 0 }],
      stateDir: proxyStateDir,
      schema: ["flags", "working_dir"],
      initialState: {},
    };
    const s = await startProxy(cfg);
    port = s.port;
    close = s.close;
  });

  afterAll(() => close && close());

  it("runs a 3-step SKILL.state loop and accumulates Σ without history", async () => {
    const url = `http://127.0.0.1:${port}/v1/chat/completions`;
    const model = "z-ai/glm-5.3-free";
    const sys = "You are a CTF agent. Track discovered flags in state. Use a ```json delta block to update state. Keep answers short.";

    const steps = [
      "List the current directory.",
      "I see secret.txt. Read it.",
      "The file contains FLAG{abc123}. Record it and confirm.",
    ];
    let lastSession = "";
    let lastStep = 0;
    let sessionHeader = "";
    for (let i = 0; i < steps.length; i++) {
      const body = {
        model,
        stream: false,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: steps[i] },
        ],
      };
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${API_KEY}`,
      };
      if (sessionHeader) headers["x-skillstate-session"] = sessionHeader;
      const r = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.choices[0].message.content).toBeTruthy();
      sessionHeader = r.headers.get("x-skillstate-session") ?? sessionHeader;
      lastSession = sessionHeader;
      lastStep = Number(r.headers.get("x-skillstate-step") ?? "0");
    }
    expect(lastSession.length).toBeGreaterThan(0);
    expect(lastStep).toBe(3);

    // state file should exist and contain accumulated keys
    const statePath = `${proxyStateDir}/${lastSession}.json`;
    expect(existsSync(statePath)).toBe(true);
    const st = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(st.step).toBe(3);
    // state should be a bounded snapshot, not a transcript
    expect(Object.keys(st.state).length).toBeLessThan(10);
  });
});
