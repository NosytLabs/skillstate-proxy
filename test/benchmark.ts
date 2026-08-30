/**
 * Live benchmark: SKILL.state vs append-only baseline.
 * Runs both loops with identical tasks against the real tokenrouter free tier.
 * Reports prompt + completion + total tokens, and the cost delta in USD/GNK.
 */
import { startProxy } from "../src/proxy.js";
import { costFor, gonkaCost } from "../src/pricing.js";
import { estimateTokens } from "../src/token-estimate.js";

const TR_KEY = process.env.TOKENROUTER_API_KEY!;
const TR_URL = process.env.TOKENROUTER_BASE_URL || "https://api.tokenrouter.com/v1";
const MODEL = "z-ai/glm-5.3-free";
const N = Number(process.argv[2] ?? 5);

const SYSTEM = `You are a long-horizon task agent. Maintain a small JSON state.
Each turn emit: (1) brief reasoning, (2) a \`\`\`json delta block of state changes, (3) action.`;

async function callBaseline(observation: string) {
  // append-only: keep full transcript
  if (!(callBaseline as any).history) (callBaseline as any).history = [{ role: "system", content: SYSTEM }];
  (callBaseline as any).history.push({ role: "user", content: observation });
  const body = { model: MODEL, stream: false, messages: (callBaseline as any).history };
  const r = await fetch(`${TR_URL}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TR_KEY}` },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  (callBaseline as any).history.push({ role: "assistant", content: j.choices?.[0]?.message?.content ?? "" });
  return {
    promptTokens: j.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages)),
    completionTokens: j.usage?.completion_tokens ?? estimateTokens(j.choices?.[0]?.message?.content ?? ""),
    content: j.choices?.[0]?.message?.content ?? "",
  };
}

async function callSkillstate(proxy: { port: number }, sid: string, observation: string) {
  const body = { model: MODEL, stream: false, messages: [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Step: ${observation}` },
  ]};
  const r = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TR_KEY}`, "x-skillstate-session": sid },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  return {
    promptTokens: j.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages)),
    completionTokens: j.usage?.completion_tokens ?? estimateTokens(j.choices?.[0]?.message?.content ?? ""),
    content: j.choices?.[0]?.message?.content ?? "",
  };
}

async function main() {
  console.log(`\n📊 Live benchmark: ${N} steps  model=${MODEL}  upstream=tokenrouter\n`);
  const tasks = [
    "Inspect the workspace",
    "Identify any sample files",
    "Compute the count of items in scope",
    "Persist your findings as JSON",
    "Reconcile any discrepancies",
    "Generate a summary report",
    "Final cleanup pass",
    "Verify the report is correct",
    "Archive the result",
    "Confirm completion",
  ];
  const s = await startProxy({
    listenPort: 8795, // different port to avoid conflict
    upstreams: [{ name: "tokenrouter", url: TR_URL, apiKey: TR_KEY, priority: 0 }],
    stateDir: "/tmp/ss-bench-" + Date.now(),
    schema: ["step", "notes", "count", "summary", "files", "completed"],
    initialState: { step: 0, notes: [], count: 0, summary: "", files: [], completed: false },
  });
  const sid = "bench-" + Date.now();

  // baseline
  (callBaseline as any).history = undefined;
  let basePrompt = 0, baseComp = 0;
  for (let i = 0; i < N; i++) {
    const r = await callBaseline(tasks[i % tasks.length] ?? `task ${i}`);
    basePrompt += r.promptTokens; baseComp += r.completionTokens;
    process.stdout.write(`\r baseline  step ${i+1}/${N}  prompt=${r.promptTokens}  comp=${r.completionTokens}`);
  }
  console.log();
  const baseTotal = basePrompt + baseComp;
  const baseUsd = costFor(MODEL, basePrompt, baseComp);
  const baseOpenaiUsd = costFor("openai/gpt-4o", basePrompt, baseComp);

  // skillstate
  let ssPrompt = 0, ssComp = 0;
  for (let i = 0; i < N; i++) {
    const r = await callSkillstate(s, sid, tasks[i % tasks.length] ?? `task ${i}`);
    ssPrompt += r.promptTokens; ssComp += r.completionTokens;
    process.stdout.write(`\r skillstate step ${i+1}/${N}  prompt=${r.promptTokens}  comp=${r.completionTokens}`);
  }
  console.log();
  const ssTotal = ssPrompt + ssComp;
  const ssUsd = costFor(MODEL, ssPrompt, ssComp);
  const ssOpenaiUsd = costFor("openai/gpt-4o", ssPrompt, ssComp);
  const ssGnk = gonkaCost(ssTotal);

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  N=${N} steps vs tokenrouter (${MODEL})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  baseline (append-only transcript):
    prompt     : ${basePrompt.toString().padStart(6)} tok
    completion : ${baseComp.toString().padStart(6)} tok
    total      : ${baseTotal.toString().padStart(6)} tok
    USD (free) : $${baseUsd.toFixed(6)}
    USD gpt-4o : $${baseOpenaiUsd.toFixed(6)}

  skillstate-proxy:
    prompt     : ${ssPrompt.toString().padStart(6)} tok
    completion : ${ssComp.toString().padStart(6)} tok
    total      : ${ssTotal.toString().padStart(6)} tok
    USD (free) : $${ssUsd.toFixed(6)}
    USD gpt-4o : $${ssOpenaiUsd.toFixed(6)}
    GNK equiv  : ${ssGnk.gnk.toFixed(6)} GNK  ($${ssGnk.usd.toFixed(6)} @ $0.12/GNK)

  Δ prompt    : ${(basePrompt - ssPrompt).toString().padStart(6)} tok  (${(((basePrompt - ssPrompt) / basePrompt) * 100).toFixed(1)}% saved)
  Δ total     : ${(baseTotal - ssTotal).toString().padStart(6)} tok  (${(((baseTotal - ssTotal) / baseTotal) * 100).toFixed(1)}%)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // also show cost ledger
  const summary = s.ledger.summarize();
  console.log(`\n💰 proxy cost ledger:\n  USD total: $${summary.totalUsd.toFixed(6)}  GNK total: ${summary.totalGnk.toFixed(6)}  by upstream:`, summary.byUpstream);
  s.close();
}

main().catch(e => { console.error(e); process.exit(1); });
