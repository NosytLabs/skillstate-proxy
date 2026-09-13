import { afterAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy } from "../src/proxy.js";

const CYCLES = 60;
let upstream: ReturnType<typeof createServer>;
let proxy: Awaited<ReturnType<typeof startProxy>>;
let root = "";

afterAll(async () => {
  await proxy?.close();
  upstream?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("long-horizon native tool loop", () => {
  it(`runs ${CYCLES * 2} logical steps while upstream context stays bounded`, async () => {
    let callNo = 0;
    const upstreamPromptSizes: number[] = [];
    const toolObservations: string[] = [];
    upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      callNo++;
      upstreamPromptSizes.push(Buffer.byteLength(JSON.stringify(body.messages ?? [])));
      res.setHeader("content-type", "application/json");
      const cycle = Math.ceil(callNo / 2);
      if (callNo % 2 === 1) {
        res.end(JSON.stringify({
          id: `tool-${cycle}`, model: "mock",
          choices: [{ index: 0, finish_reason: "tool_calls", message: {
            role: "assistant", content: null,
            tool_calls: [{ id: `call_${cycle}`, type: "function", function: { name: "lookup", arguments: JSON.stringify({ cycle }) } }],
          }}],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        }));
        return;
      }
      const observation = String(body.messages?.[1]?.content ?? "");
      toolObservations.push(observation);
      res.end(JSON.stringify({
        id: `state-${cycle}`, model: "mock",
        choices: [{ index: 0, finish_reason: "stop", message: {
          role: "assistant",
          content: `\`\`\`json\n${JSON.stringify({ state_patch: { cycle, lastResult: `result-${cycle}` }, action: "continue" })}\n\`\`\``,
        }}],
        usage: { prompt_tokens: 24, completion_tokens: 8 },
      }));
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    root = mkdtempSync(join(tmpdir(), "ss-tool-horizon-"));
    proxy = await startProxy({
      listenPort: 0,
      stateDir: join(root, "state"), costLedgerPath: join(root, "cost.jsonl"),
      upstreams: [{ name: "mock", url: `http://127.0.0.1:${(upstream.address() as any).port}/v1`, priority: 0 }],
      schema: ["cycle", "lastResult"],
      initialState: { cycle: 0, lastResult: "" },
      maxRetries: 0,
    });

    const sid = "tool-horizon";
    const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { cycle: { type: "number" } }, required: ["cycle"] } } }];
    const history: any[] = [{ role: "system", content: "Track cycle and lastResult. Use lookup every cycle." }];

    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      history.push({ role: "user", content: `cycle ${cycle}: look it up` });
      const toolResponse = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-skillstate-session": sid },
        body: JSON.stringify({ model: "mock", tools, tool_choice: "auto", messages: history }),
      });
      expect(toolResponse.status).toBe(200);
      const toolJson: any = await toolResponse.json();
      const toolCall = toolJson.choices[0].message.tool_calls[0];
      history.push({ role: "assistant", content: null, tool_calls: [toolCall] });
      history.push({ role: "tool", tool_call_id: toolCall.id, name: "lookup", content: `result-${cycle}` });

      const stateResponse = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-skillstate-session": sid },
        body: JSON.stringify({ model: "mock", tools, tool_choice: "auto", messages: history }),
      });
      expect(stateResponse.status).toBe(200);
      const stateJson: any = await stateResponse.json();
      history.push(stateJson.choices[0].message);
    }

    const state: any = await fetch(`http://127.0.0.1:${proxy.port}/state?session=${sid}`).then(r => r.json());
    expect(state.step).toBe(CYCLES * 2);
    expect(state.state).toEqual({ cycle: CYCLES, lastResult: `result-${CYCLES}` });
    expect(toolObservations).toHaveLength(CYCLES);
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      expect(toolObservations[cycle - 1]).toContain(`call_${cycle}`);
      expect(toolObservations[cycle - 1]).toContain(`result-${cycle}`);
    }

    // The client transcript above grows to 181+ messages, but every upstream call
    // remains the exact two-message (P, Σ, O) projection and stays under a small cap.
    expect(history.length).toBeGreaterThan(180);
    expect(Math.max(...upstreamPromptSizes)).toBeLessThan(5_000);
    expect(Math.max(...upstreamPromptSizes) - Math.min(...upstreamPromptSizes)).toBeLessThan(3_000);
  });
});
