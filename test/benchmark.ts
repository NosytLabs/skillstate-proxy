/**
 * Quick benchmark: SKILL.state vs append-only baseline.
 * Compares prompt tokens across N steps of both approaches.
 *
 * Usage:
 *   SKILLSTATE_API_KEY=<key> SKILLSTATE_MODEL=<model> npx tsx test/benchmark.ts [steps]
 *   Defaults: Venice qwen3-5-9b, 5 steps.
 */
import { startProxy } from "../src/proxy.js";

const API_KEY = process.env.SKILLSTATE_API_KEY;
const UPSTREAM = process.env.SKILLSTATE_UPSTREAM ?? "https://api.venice.ai/api/v1";
const MODEL = process.env.SKILLSTATE_MODEL ?? "qwen3-5-9b";
const N = Number(process.argv[2] ?? 5);

if (!API_KEY) {
  console.error("Set SKILLSTATE_API_KEY to your API key.");
  process.exit(2);
}

const SYSTEM = `You are a long-horizon task agent. Maintain a small JSON state.
Each turn emit: (1) brief reasoning, (2) a \`\`\`json delta block of state changes, (3) action.`;

async function callUpstream(messages: { role: string; content: string }[]) {
  const body = { model: MODEL, stream: false, messages };
  const r = await fetch(`${UPSTREAM}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  return {
    promptTokens: j.usage?.prompt_tokens ?? 0,
    completionTokens: j.usage?.completion_tokens ?? 0,
    content: j.choices?.[0]?.message?.content ?? "",
  };
}

async function main() {
  const tasks = [
    "Inspect the workspace", "Identify sample files", "Compute item count",
    "Persist findings as JSON", "Reconcile discrepancies", "Generate summary report",
    "Final cleanup pass", "Verify report correctness", "Archive the result", "Confirm completion",
  ];

  console.log(`\nBenchmark: ${N} steps · ${MODEL} · ${UPSTREAM.includes("venice") ? "Venice" : "custom upstream"}\n`);

  // Baseline: append-only transcript
  const baseHistory: { role: string; content: string }[] = [{ role: "system", content: SYSTEM }];
  let basePrompt = 0, baseComp = 0;
  for (let i = 0; i < N; i++) {
    baseHistory.push({ role: "user", content: tasks[i % tasks.length] });
    const r = await callUpstream(baseHistory);
    baseHistory.push({ role: "assistant", content: r.content });
    basePrompt += r.promptTokens;
    baseComp += r.completionTokens;
    process.stdout.write(`\r  baseline  step ${i + 1}/${N}  prompt=${r.promptTokens}`);
  }
  console.log();

  // SKILL.state: bounded prompts
  const s = await startProxy({
    listenPort: 0,
    upstreams: [{ name: "upstream", url: UPSTREAM, apiKey: API_KEY, priority: 0 }],
    stateDir: "/tmp/ss-bench-" + Date.now(),
    schema: ["step", "notes", "count"],
    initialState: { step: 0, notes: [], count: 0 },
  });
  const sid = "bench-" + Date.now();
  let ssPrompt = 0, ssComp = 0;
  for (let i = 0; i < N; i++) {
    const body = { model: MODEL, stream: false, messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: tasks[i % tasks.length] },
    ]};
    const r = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}`, "x-skillstate-session": sid },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    ssPrompt += j.usage?.prompt_tokens ?? 0;
    ssComp += j.usage?.completion_tokens ?? 0;
    process.stdout.write(`\r  skillstate step ${i + 1}/${N}  prompt=${j.usage?.prompt_tokens ?? 0}`);
  }
  console.log();
  s.close();

  const baseTotal = basePrompt + baseComp;
  const ssTotal = ssPrompt + ssComp;
  const saved = basePrompt - ssPrompt;

  console.log(`
${"━".repeat(50)}
  Baseline:  ${basePrompt} prompt / ${baseTotal} total tokens
  SKILL.state: ${ssPrompt} prompt / ${ssTotal} total tokens
  Prompt saved: ${saved} tokens (${((saved / basePrompt) * 100).toFixed(1)}%)
${"━".repeat(50)}
  At 200 steps, baseline would be ~${Math.round(basePrompt * (200 / N)).toLocaleString()} prompt tokens.
  SKILL.state stays at ~${Math.round(ssPrompt / N).toLocaleString()} tokens/step.
${"━".repeat(50)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
