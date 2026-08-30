// Long-horizon software-repo task (SkillExecBench Env 2) on Gonka decentralized
// compute. Tracks branches, commits, PRs, CI, releases. Uses SKILL.state to
// keep prompt size O(1) across the 10+ steps. Reports cost in GNK + USD.
import { startProxy } from "../src/proxy.js";
import { gonkaCost } from "../src/pricing.js";

const KEY = process.env.GONKA_API_KEY!;
const URL = process.env.GONKA_BASE_URL || "https://api.openbroker.gonka.gg/v1";
const MODEL = process.env.MODEL || "MiniMaxAI/MiniMax-M2.7";
const N = Number(process.argv[2] ?? 10);

const SYSTEM = `You are a software repository management agent (SkillExecBench Env 2).
Maintain a JSON state representing: branches, commits, PRs, CI status, releases.
Actions: CherryPick, Merge, RunTests, CreateRelease, Rollback.
Each turn emit: (1) reasoning, (2) a \`\`\`json delta block, (3) action.`;

const tasks = [
  "Branch feature/oauth from main at commit abc123",
  "Cherry-pick commit def456 onto release/1.2",
  "Open PR #142: feature/oauth -> main",
  "Run tests on PR #142 — note 3 failures",
  "Push fix commit to feature/oauth",
  "Re-run tests on PR #142 — all green",
  "Merge PR #142 to main",
  "Tag main as v1.3.0 and create release notes",
  "Cherry-pick hotfix ghi789 onto release/1.2",
  "Rollback release/1.2 to previous tag v1.1.9",
];

async function main() {
  const s = await startProxy({
    listenPort: 8794,
    upstreams: [{ name: "gonka", url: URL, apiKey: KEY, priority: 0 }],
    stateDir: "/tmp/ss-repo-" + Date.now(),
    schema: ["branches", "commits", "prs", "ci", "releases", "step"],
    initialState: { branches: ["main"], commits: ["abc123"], prs: [], ci: {}, releases: [], step: 0 },
  });
  const sid = "repo-" + Date.now();
  console.log(`\n[skillstate] long-horizon software repo: ${N} steps  model=${MODEL}  upstream=gonka\n`);

  let totalTokens = 0;
  for (let i = 0; i < N; i++) {
    const r = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, "x-skillstate-session": sid },
      body: JSON.stringify({ model: MODEL, stream: false, messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Step ${i+1}: ${tasks[i] ?? `task ${i}`}` },
      ] }),
    });
    const j = await r.json();
    const usage = j.usage ?? {};
    const inTok = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const outTok = usage.completion_tokens ?? usage.output_tokens ?? 0;
    totalTokens += inTok + outTok;
    const c = gonkaCost(inTok + outTok);
    console.log(` step ${(i+1).toString().padStart(2)}/${N}  tok=${(inTok+outTok).toString().padStart(5)}  gnk=${c.gnk.toFixed(7)}  usd=$${c.usd.toFixed(6)}  [${r.headers.get("x-skillstate-statekeys")}]`);
  }

  const tc = gonkaCost(totalTokens);
  const baselineGpt4o = (totalTokens / 1_000_000) * (5.0 + 15.0) / 2 * 1.5; // ~proxy would have been 1.5x tokens baseline
  console.log(`\nTotal: ${totalTokens} tokens -> ${tc.gnk.toFixed(6)} GNK  ($${tc.usd.toFixed(6)} @ $0.12/GNK)`);
  console.log(` vs OpenAI gpt-4o equivalent: ~$${baselineGpt4o.toFixed(4)}  — ~${(baselineGpt4o / tc.usd).toFixed(0)}x more expensive`);
  console.log(`\n💰 ledger:`, s.ledger.summarize());
  s.close();
}

main().catch(e => { console.error(e); process.exit(1); });
