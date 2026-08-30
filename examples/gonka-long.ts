// Gonka long-horizon showcase — real GNK+USD cost tracking
// Run: GONKA_API_KEY=... npx tsx examples/gonka-long.ts
import { startProxy } from "../src/proxy.js";
import { gonkaCost } from "../src/pricing.js";
const KEY = process.env.GONKA_API_KEY!;
const URL = "https://api.openbroker.gonka.gg/v1";
const MODEL = "MiniMaxAI/MiniMax-M2.7";

const SYSTEM = `You are a helpful agent. Track conversation progress in state: { step: number, notes: string[] }. Emit \`\`\`json delta after reasoning.`;

async function run(n=8) {
  const s = await startProxy({ listenPort: 8794, upstreams:[{ name:"gonka", url:URL, apiKey:KEY, priority:0 }], stateDir:"/tmp/ss-gonka-"+Date.now(), schema:["step","notes"], initialState:{ step:0, notes:[] } });
  let total=0;
  for (let i=0;i<n;i++) {
    const r = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, { method:"POST", headers:{ "content-type":"application/json", authorization:`Bearer ${KEY}`}, body: JSON.stringify({ model:MODEL, stream:false, messages:[{role:"system",content:SYSTEM},{role:"user",content:`Step ${i+1}: summarize step ${i+1} briefly and update state.`}] }) });
    const j=await r.json();
    const u=j.usage??{}; const tok=(u.prompt_tokens??0)+(u.completion_tokens??0); total+=tok;
    const { gnk, usd } = gonkaCost(tok);
    console.log(` step ${i+1}/${n} tok=${tok} gnk=${gnk.toFixed(6)} usd=$${usd.toFixed(6)} [${r.headers.get("x-skillstate-statekeys")}]`);
  }
  const { gnk, usd } = gonkaCost(total);
  console.log(`\nTotal ${n} steps: ${total} tokens -> ${gnk.toFixed(6)} GNK ($${usd.toFixed(6)} @ $0.12/GNK)`);
  console.log(` vs OpenAI gpt-4o (same tokens): $${((total/1e6)*5).toFixed(4)} input + $${((total/1e6)*15).toFixed(4)} output — ~${Math.round(15/0.0012)}x more`);
  s.close();
}
run(Number(process.argv[2] ?? 8)).catch(e=>{console.error(e);process.exit(1)});
