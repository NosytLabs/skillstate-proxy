// Warehouse — Store/Ship/Move over 500 shelves
// Demonstrates SKILL.state vs history-append over a long horizon.
// Run: SKILLSTATE_LIVE=1 npx tsx examples/warehouse.ts

import { startProxy } from "../src/proxy.js";
const TR_KEY = process.env.TOKENROUTER_API_KEY!;
const TR_URL = process.env.TOKENROUTER_BASE_URL || "https://api.tokenrouter.com/v1";
const MODEL = "z-ai/glm-5.3-free";

const SYSTEM = `You are a Warehouse Management agent (SkillExecBench Env 1).
Maintain shelves 0-499. Actions: Store, Ship, Move, Wait.
State schema: { shelves: { [id: number]: string[] }, pending: string[], step: number }
After each observation, emit reasoning, then a \`\`\`json delta of state changes, then the action.`;

async function run(n=20) {
  const s = await startProxy({ listenPort: 8792, upstreams:[{name:"tokenrouter", url:TR_URL, apiKey:TR_KEY, priority:0}], stateDir:"/tmp/ss-warehouse-"+Date.now(), schema:["shelves","pending","step"], initialState:{ shelves:{}, pending:[], step:0 } });
  console.log(`[warehouse] ${n} steps via skillstate-proxy http://127.0.0.1:${s.port}`);
  for (let i=0;i<n;i++) {
    const obs = i%3===0 ? `Store crate_${i} on shelf_${(i*7)%500}` : i%3===1 ? `Ship crate_${i-1} from shelf_${((i-1)*7)%500}` : `Move crate_${i-2} from shelf_${((i-2)*7)%500} to shelf_${(i*11)%500}`;
    const r = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, { method:"POST", headers:{ "content-type":"application/json", authorization:`Bearer ${TR_KEY}`}, body: JSON.stringify({ model:MODEL, stream:false, messages:[{role:"system",content:SYSTEM},{role:"user",content:`Step ${i+1}: ${obs}.`}] }) });
    const j=await r.json();
    console.log(` step ${i+1} [Σ keys: ${r.headers.get("x-skillstate-statekeys")}] -> ${(j.choices?.[0]?.message?.content ?? "").slice(0,120).replace(/\n/g," ")}`);
  }
  s.close(); console.log("done. State persisted per session; prompt stayed O(1).");
}
run(Number(process.argv[2] ?? 20)).catch(e=>{console.error(e);process.exit(1)});
