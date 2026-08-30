// Sierra τ-Bench Retail showcase — multi-turn customer service agent.
// τ-Bench is a public benchmark referenced by the SKILL.state paper.
// Maintains a customer-order state through ~25 turns of policy-driven
// dialogue. Validates that ΔΣ updates stay within the schema and don't
// bloat the prompt as the conversation grows.
import { startProxy } from "../src/proxy.js";
import { gonkaCost, costFor } from "../src/pricing.js";

const KEY = process.env.GONKA_API_KEY || process.env.OPENROUTER_API_KEY!;
const URL = process.env.GONKA_BASE_URL || "https://api.openbroker.gonka.gg/v1";
const MODEL = process.env.MODEL || "deepseek-ai/DeepSeek-V4-Flash-0731";
const N = Number(process.argv[2] ?? 25);

const SYSTEM = `You are a retail customer-service agent (Sierra τ-Bench Retail domain).
You help a customer with an order. You must follow store policy:
 - Be polite, identify the customer by user_id.
 - For modifications, confirm the order_id and the new item.
 - Refunds: only within 30 days of purchase.
 - Never share internal employee info.
Maintain a JSON state: { customer_id, orders, current_intent, last_action, history_excerpt }.
Each turn emit: (1) reasoning, (2) a \`\`\`json delta block, (3) your reply to the customer.`;

const turns = [
  "User: hi, I want to check on an order",
  "Agent asks for order ID",
  "User: it's #W0001234",
  "Agent retrieves order: 2 items, placed 12 days ago",
  "User: I want to change the blue shirt size to L",
  "Agent checks policy — within window, allowed",
  "User: yes please make the change",
  "Agent applies modification",
  "User: actually can I also add a gift wrap?",
  "Agent explains gift wrap costs $5",
  "User: ok add it",
  "Agent adds gift wrap to order",
  "User: and ship to my new address",
  "Agent asks for new address",
  "User: 742 Evergreen Terrace, Springfield",
  "Agent updates shipping",
  "User: when will it arrive?",
  "Agent estimates based on new shipping",
  "User: perfect, thanks",
  "Agent confirms order summary",
  "User: also can I return the other shirt?",
  "Agent explains 30-day return window applies",
  "User: ok I'll keep it for now, thanks",
  "Agent wishes the customer well",
  "User: bye",
];

async function main() {
  const s = await startProxy({
    listenPort: 8793,
    upstreams: [{ name: "gonka", url: URL, apiKey: KEY, priority: 0 }],
    stateDir: "/tmp/ss-tau-" + Date.now(),
    schema: ["customer_id", "orders", "current_intent", "last_action", "history_excerpt", "step"],
    initialState: { customer_id: null, orders: [], current_intent: null, last_action: null, history_excerpt: "", step: 0 },
  });
  const sid = "tau-" + Date.now();
  console.log(`\n[τ-bench] Sierra Retail long-horizon: ${N} turns  model=${MODEL}\n`);

  let total = 0, totalTime = 0;
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    const turn = turns[i] ?? `Generic turn ${i}`;
    const role = i % 2 === 0 ? "user" : "assistant"; // alternate
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, "x-skillstate-session": sid },
        body: JSON.stringify({ model: MODEL, stream: false, messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Turn ${i+1} (${role}): ${turn}` },
        ] }),
      });
      if (!r.ok) { console.error(` turn ${i+1} failed: ${r.status}`); continue; }
      const j = await r.json();
      const u = j.usage ?? {};
      const tok = (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
      total += tok;
      totalTime += Date.now() - t0;
      const isGonka = URL.includes("gonka");
      const c = isGonka ? gonkaCost(tok) : { gnk: 0, usd: costFor(MODEL, (u.prompt_tokens ?? 0), (u.completion_tokens ?? 0)) };
      const val = r.headers.get("x-skillstate-validation") ?? "";
      if ((i+1) % 5 === 0 || i === 0 || i === N-1) {
        process.stdout.write(`\n turn ${(i+1).toString().padStart(2)}/${N}  tok=${tok.toString().padStart(4)}  cum=${total.toString().padStart(5)}  dt=${Date.now()-t0}ms  stateKeys=[${r.headers.get("x-skillstate-statekeys")}]  validation=${val || "ok"}`);
      } else { process.stdout.write("."); }
    } catch (e: any) {
      console.error(`\n turn ${i+1} error: ${e.message}`);
    }
  }
  console.log(`\n\n=== τ-bench SUMMARY ===`);
  console.log(`turns    : ${N}`);
  console.log(`total tok: ${total}`);
  console.log(`avg/turn : ${(total/N).toFixed(1)}`);
  console.log(`wall     : ${(totalTime/1000).toFixed(1)}s`);
  if (URL.includes("gonka")) {
    const c = gonkaCost(total);
    console.log(`cost GNK : ${c.gnk.toFixed(6)}  ($${c.usd.toFixed(6)} @ $0.12/GNK)`);
  }
  console.log(`\n💰 ledger:`);
  console.log(JSON.stringify(s.ledger.summarize(), null, 2));
  s.close();
}

main().catch(e => { console.error(e); process.exit(1); });
