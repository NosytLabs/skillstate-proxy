import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startProxy, type ProxyConfig } from "../src/proxy.js";
import { existsSync, readFileSync } from "node:fs";

/**
 * LIVE integration test — runs if SKILLSTATE_LIVE=1 + API key present.
 * Tests the full 3-step SKILL.state loop against a real upstream.
 */
const LIVE = process.env.SKILLSTATE_LIVE === "1";
const API_KEY = process.env.SKILLSTATE_API_KEY;
const BASE_URL = process.env.SKILLSTATE_UPSTREAM ?? "https://api.venice.ai/api/v1";
const MODEL = process.env.SKILLSTATE_MODEL ?? "qwen3-5-9b";

describe.skipIf(!LIVE || !API_KEY)("live: 3-step SKILL.state loop", () => {
  let port = 0;
  let close: () => void;
  let stateDir = "/tmp/skillstate-live-" + Date.now();

  beforeAll(async () => {
    const cfg: Partial<ProxyConfig> = {
      listenPort: 0,
      upstreams: [{ name: "upstream", url: BASE_URL, apiKey: API_KEY, priority: 0 }],
      stateDir,
      schema: ["flags", "working_dir"],
      initialState: {},
    };
    const s = await startProxy(cfg);
    port = s.port;
    close = s.close;
  });

  afterAll(() => close?.());

  it("runs 3 steps and accumulates Σ without history", async () => {
    const url = `http://127.0.0.1:${port}/v1/chat/completions`;
    const sys = "You are a CTF agent. Track discovered flags in state. Use a ```json delta block to update state. Keep answers short.";

    const steps = [
      "List the current directory.",
      "I see secret.txt. Read it.",
      "The file contains FLAG{abc123}. Record it and confirm.",
    ];
    let sessionHeader = "";
    let lastStep = 0;
    for (let i = 0; i < steps.length; i++) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${API_KEY}`,
      };
      if (sessionHeader) headers["x-skillstate-session"] = sessionHeader;
      const r = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: MODEL, stream: false,
          messages: [{ role: "system", content: sys }, { role: "user", content: steps[i] }],
        }),
      });
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.choices[0].message.content).toBeTruthy();
      sessionHeader = r.headers.get("x-skillstate-session") ?? sessionHeader;
      lastStep = Number(r.headers.get("x-skillstate-step") ?? "0");
    }
    expect(sessionHeader.length).toBeGreaterThan(0);
    expect(lastStep).toBe(3);

    const statePath = `${stateDir}/${sessionHeader}.json`;
    expect(existsSync(statePath)).toBe(true);
    const st = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(st.step).toBe(3);
    expect(Object.keys(st.state).length).toBeLessThan(10);
  });
});
