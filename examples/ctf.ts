// CTF — InterCode-style terminal exploitation
// Demonstrates the 5-field schema from the paper: discovered_flags, tested_hypotheses, active_files, working_dir, cmd_summary
// Run: SKILLSTATE_LIVE=1 npx tsx examples/ctf.ts

import { startProxy } from "../src/proxy.js";
const TR_KEY = process.env.TOKENROUTER_API_KEY!;
const TR_URL = process.env.TOKENROUTER_BASE_URL || "https://api.tokenrouter.com/v1";
const MODEL = "z-ai/glm-5.3-free";

const SYSTEM = `You are a CTF agent in a Linux terminal. Schema: { discovered_flags: string[], tested_hypotheses: string[], active_files: string[], working_dir: string, cmd_summary: string }
Emit reasoning, then \`\`\`json delta, then a bash command as your action.`;

async function run() {
  const s = await startProxy({ listenPort: 8793, upstreams:[{ name:"tokenrouter", url:TR_URL, apiKey:TR_KEY, priority:0 }], stateDir:"/tmp/ss-ctf-"+Date.now(), schema:["discovered_flags","tested_hypotheses","active_files","working_dir","cmd_summary"], initialState:{ discovered_flags:[], tested_hypotheses:[], active_files:[], working_dir:"/tmp", cmd_summary:"" } });
  const steps = ["List the current directory.", "I see secret.txt. Read it.", "The file contains FLAG{abc123}. Record it and confirm."];
  let sid="";
  for (let i=0;i<steps.length;i++) {
    const headers: Record<string,string> = { "content-type":"application/json", authorization:`Bearer ${TR_KEY}` };
    if (sid) headers["x-skillstate-session"]=sid;
    const r = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, { method:"POST", headers, body: JSON.stringify({ model:MODEL, stream:false, messages:[{role:"system",content:SYSTEM},{role:"user",content:steps[i]}] }) });
    const j=await r.json();
    sid = r.headers.get("x-skillstate-session") ?? sid;
    console.log(`step ${i+1} [${r.headers.get("x-skillstate-statekeys")}] ${(j.choices?.[0]?.message?.content ?? "").slice(0,140).replace(/\n/g," ")}`);
  }
  console.log(`final session ${sid} — bounded Σ, no transcript replay.`);
  s.close();
}
run().catch(e=>{console.error(e);process.exit(1)});
