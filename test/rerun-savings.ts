/**
 * Cross-session re-run savings — the README's "same-day re-run 91%" claim.
 * Distinct usecase from benchmark.ts (within-run bounded context):
 * run the SAME 10-step security-review task twice against the SAME
 * skillstate session. The second run should hit warm Σ state and cost
 * a fraction of the first run's prompt tokens.
 *
 * Usage: SKILLSTATE_API_KEY=... SKILLSTATE_UPSTREAM=http://127.0.0.1:8789/v1 \
 *   npx tsx test/rerun-savings.ts [steps=10]
 */
const UPSTREAM = process.env.SKILLSTATE_UPSTREAM ?? "http://127.0.0.1:8789/v1";
const API_KEY = process.env.SKILLSTATE_API_KEY ?? "";
const MODEL = process.env.SKILLSTATE_MODEL ?? "deepseek-ai/DeepSeek-V4-Flash-0731";
const N = Number(process.argv[2] ?? 10);

if (!API_KEY) throw new Error("SKILLSTATE_API_KEY is required");

const SYSTEM =
  "You are a long-horizon coding agent performing a security review of an auth module. " +
  "Track progress in structured state. Each turn you receive an observation and must reply with:\n" +
  "1) Brief reasoning about what to do next\n" +
  "2) A ```json block with a state_patch (your state updates) and an action";

const TASKS = [
  "Review src/auth/login.ts for credential handling flaws.",
  "Review src/auth/session.ts for fixation/timing issues.",
  "Review src/auth/tokens.ts for expiry and revocation gaps.",
  "Review src/auth/permissions.ts for privilege escalation paths.",
  "Review src/auth/middleware.ts for bypass conditions.",
  "Review src/auth/oauth.ts for redirect/state flaws.",
  "Review src/auth/password.ts for hashing/rotation gaps.",
  "Review src/auth/mfa.ts for enrollment bypasses.",
  "Review src/auth/audit.ts for log-tampering blind spots.",
  "Review src/auth/ratelimit.ts for brute-force windows.",
];

async function runPass(
  ssPort: number,
  sid: string,
  label: string,
): Promise<{ prompt: number; comp: number; gaps: number }> {
  let prompt = 0;
  let comp = 0;
  let gaps = 0;
  for (let i = 0; i < N; i++) {
    const body = {
      model: MODEL,
      stream: false,
      max_tokens: 300,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Step ${i + 1}: ${TASKS[i % TASKS.length]}` },
      ],
    };
    try {
      const r = await fetch(`http://127.0.0.1:${ssPort}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${API_KEY}`,
          "x-skillstate-session": sid,
        },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(`${label} step ${i + 1} failed (${r.status}): ${JSON.stringify(j).slice(0, 200)}`);
      if (j.error && !j.choices) throw new Error(`${label} step ${i + 1} error body: ${JSON.stringify(j).slice(0, 200)}`);
      if (j.usage?.prompt_tokens == null) throw new Error(`${label} step ${i + 1} omitted usage — refusing silent 0`);
      prompt += j.usage.prompt_tokens;
      comp += j.usage.completion_tokens ?? 0;
      process.stdout.write(`\r  ${label} ${(i + 1).toString().padStart(2)}/${N}  prompt=${j.usage.prompt_tokens.toString().padStart(5)}  cum=${prompt}`);
    } catch (e: any) {
      gaps++;
      console.error(`\n  ⚠ ${label} step ${i + 1}: ${e.message}`);
    }
    if (i < N - 1) await new Promise((r) => setTimeout(r, 300));
  }
  console.log();
  return { prompt, comp, gaps };
}

async function main() {
  const { startProxy } = await import("../src/proxy.js");
  const stateDir = `/tmp/ss-rerun-${Date.now()}`;
  const ss = await startProxy({
    listenPort: 0,
    stateDir,
    upstreams: [{ name: "upstream", url: UPSTREAM, apiKey: API_KEY, priority: 0 }],
    schema: ["step", "files_checked", "issues_found", "critical", "high", "medium", "low", "summary", "completed"],
    initialState: { step: 0, files_checked: [], issues_found: [], critical: 0, high: 0, medium: 0, low: 0, summary: "", completed: false },
    maxRetries: 2,
  });
  const port = ss.port;
  const sid = `rerun-${Date.now().toString(36)}`;
  console.log(`\nSKILL.state re-run savings · ${N} steps × 2 passes · ${MODEL}`);
  console.log(`session: ${sid}\n`);

  console.log("▸ PASS 1 (cold Σ)...");
  const p1 = await runPass(port, sid, "pass1");
  console.log(`  pass1 total: ${p1.prompt} prompt / ${p1.comp} completion / ${p1.gaps} gaps`);

  console.log("▸ PASS 2 (warm Σ, same session)...");
  const p2 = await runPass(port, sid, "pass2");
  console.log(`  pass2 total: ${p2.prompt} prompt / ${p2.comp} completion / ${p2.gaps} gaps`);

  if (p1.prompt > 0 && p2.prompt > 0) {
    const saved = ((p1.prompt - p2.prompt) / p1.prompt) * 100;
    console.log(`\n  re-run savings: ${saved.toFixed(1)}% fewer prompt tokens (pass2 vs pass1)`);
  } else {
    console.log("\n  inconclusive: one pass has no usable token data (gaps)");
  }
  (ss as any).close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
