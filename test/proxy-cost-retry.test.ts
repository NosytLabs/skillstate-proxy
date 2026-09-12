import { afterAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy } from "../src/proxy.js";

let upstream: ReturnType<typeof createServer>;
let proxy: Awaited<ReturnType<typeof startProxy>>;
let dir = "";

afterAll(async () => {
  await proxy?.close();
  upstream?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("logical turn cost across transport retries", () => {
  it("adds usage-bearing retryable attempts to x-skillstate-cost-usd and the ledger", async () => {
    let calls = 0;
    upstream = createServer(async (req, res) => {
      for await (const _ of req) { /* drain */ }
      calls++;
      res.setHeader("content-type", "application/json");
      if (calls === 1) {
        res.statusCode = 500;
        res.end(JSON.stringify({ model: "priced", error: "retry", usage: { prompt_tokens: 2, completion_tokens: 0 } }));
        return;
      }
      res.end(JSON.stringify({
        model: "priced",
        choices: [{ index: 0, message: { role: "assistant", content: '```json\n{"state_patch":{},"action":"done"}\n```' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 0 },
      }));
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    dir = mkdtempSync(join(tmpdir(), "ss-cost-retry-"));
    proxy = await startProxy({
      listenPort: 0, stateDir: join(dir, "state"), costLedgerPath: join(dir, "cost.jsonl"), retryAfterCapMs: 1,
      upstreams: [{
        name: "priced", url: `http://127.0.0.1:${(upstream.address() as any).port}/v1`, priority: 0,
        pricing: { mode: "usd", inputPerMillion: 1_000_000, outputPerMillion: 0 },
      }],
    });
    const r = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-skillstate-session": "cost" },
      body: JSON.stringify({ model: "priced", messages: [{ role: "system", content: "spec" }, { role: "user", content: "go" }] }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-skillstate-cost-usd")).toBe("5.000000");
    const summary: any = await fetch(`http://127.0.0.1:${proxy.port}/cost`).then(x => x.json());
    expect(summary.totalUsd).toBe(5);
    expect(summary.byAttemptKind["transport-retry"]).toBe(1);
    expect(summary.byAttemptKind.generation).toBe(1);
  });
});
