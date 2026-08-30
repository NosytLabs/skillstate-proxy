/**
 * Venice real-cost benchmark: SKILL.state vs append-only baseline.
 * Uses Venice's actual reported costs (response.usage.cost.usd) for
 * accurate per-step dollar amounts across 50 steps.
 *
 * Usage:
 *   SKILLSTATE_API_KEY=<key> npx tsx test/benchmark-venice.ts [steps]
 *
 * Environment:
 *   SKILLSTATE_API_KEY  — Venice API key (with VENICE_INFERENCE_KEY_ prefix)
 *   SKILLSTATE_MODEL    — model to use (default: qwen3-5-9b)
 *   SKILLSTATE_STEPS    — number of steps (default: 50, CLI arg overrides)
 */
import { startProxy } from "../src/proxy.js";

const VENICE_KEY = process.env.SKILLSTATE_API_KEY;
const MODEL = process.env.SKILLSTATE_MODEL ?? "qwen3-5-9b";
const N = Number(process.argv[2] ?? process.env.SKILLSTATE_STEPS ?? 50);

if (!VENICE_KEY) {
  console.error("Set SKILLSTATE_API_KEY to your Venice API key.");
  process.exit(2);
}

const VENICE_URL = "https://api.venice.ai/api/v1";

const SYSTEM = `You are a long-horizon coding agent performing a code review. Track progress in structured state. Each turn you receive an observation and must:
1) Brief reasoning about what to do next
2) A \`\`\`json block with a state_patch (your state updates) and an action

Example reply:
I should examine the file for issues.
\`\`\`json
{"state_patch": {"step": 1, "files_checked": ["main.ts"], "issues_found": []}, "action": "read main.ts"}
\`\`\``;

const TASKS = [
  "Start code review of the auth module. List all files in src/auth/.",
  "Read src/auth/login.ts. Check for input validation.",
  "Read src/auth/session.ts. Check for session management issues.",
  "Read src/auth/middleware.ts. Check for JWT verification.",
  "Read src/auth/tokens.ts. Check for token generation logic.",
  "Read src/auth/permissions.ts. Check role-based access control.",
  "Read src/auth/oauth.ts. Check OAuth flow implementation.",
  "Read src/auth/api-keys.ts. Check API key generation and storage.",
  "Check src/auth/index.ts for proper exports and barrel patterns.",
  "Scan all auth files for hardcoded secrets or credentials.",
  "Check for SQL injection vulnerabilities in auth queries.",
  "Check for XSS vulnerabilities in auth response handling.",
  "Check password hashing implementation in register flow.",
  "Check rate limiting on login endpoint.",
  "Check session expiration and cleanup logic.",
  "Check CSRF protection on state-changing auth endpoints.",
  "Review error messages for information leakage.",
  "Check logging of auth events (login, logout, failures).",
  "Check for proper HTTPS enforcement.",
  "Review token revocation implementation.",
  "Check multi-factor authentication flow.",
  "Review password reset flow for security issues.",
  "Check account lockout after failed attempts.",
  "Review API key rotation mechanism.",
  "Check for proper input sanitization across all endpoints.",
  "Review the database migration files for auth schema.",
  "Check foreign key constraints on user sessions.",
  "Review index performance on auth queries.",
  "Check connection pool configuration.",
  "Review the auth test suite for coverage gaps.",
  "Check for proper use of bcrypt vs argon2.",
  "Review JWT claims and expiration policy.",
  "Check for token replay attacks prevention.",
  "Review OAuth state parameter handling.",
  "Check for open redirect vulnerabilities in OAuth.",
  "Review cookie security settings (HttpOnly, Secure, SameSite).",
  "Check for proper CORS configuration on auth endpoints.",
  "Review the auth configuration file for secure defaults.",
  "Check for environment variable handling of secrets.",
  "Review the auth types and interfaces for completeness.",
  "Check for proper error boundary handling.",
  "Review the auth logging to ensure no PII leakage.",
  "Check for proper cleanup of sensitive data in memory.",
  "Review the auth module's dependency graph for issues.",
  "Check for proper use of timing-safe comparisons.",
  "Review the auth rate limiter implementation details.",
  "Check for proper handling of concurrent auth requests.",
  "Review the final auth module documentation.",
  "Compile all findings into a structured security report.",
  "Final: mark review as complete, summarize critical/high/medium/low issues.",
];

interface StepResult { step: number; promptTokens: number; completionTokens: number; costUsd: number; }

async function callVenice(
  messages: { role: string; content: string }[],
  label: string,
): Promise<{ content: string; promptTokens: number; completionTokens: number; costUsd: number }> {
  const body = { model: MODEL, stream: false, messages, max_tokens: 300, temperature: 0.3 };
  const r = await fetch(`${VENICE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${VENICE_KEY}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Venice ${label} failed (${r.status}): ${err.slice(0, 200)}`);
  }
  const j = await r.json();
  return {
    content: j.choices?.[0]?.message?.content ?? "",
    promptTokens: j.usage?.prompt_tokens ?? 0,
    completionTokens: j.usage?.completion_tokens ?? 0,
    costUsd: j.cost?.usd ?? 0,
  };
}

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SKILL.state Benchmark — Venice (${MODEL}) · ${N} steps`);
  console.log(`${"═".repeat(60)}\n`);

  // ── Baseline ──
  console.log("▸ BASELINE (append-only)...");
  const baseHistory: { role: string; content: string }[] = [{ role: "system", content: SYSTEM }];
  let basePrompt = 0, baseComp = 0, baseCost = 0;
  const baseSteps: StepResult[] = [];

  for (let i = 0; i < N; i++) {
    baseHistory.push({ role: "user", content: `Step ${i + 1}: ${TASKS[i % TASKS.length]}` });
    try {
      const r = await callVenice(baseHistory, `baseline-${i}`);
      baseHistory.push({ role: "assistant", content: r.content });
      basePrompt += r.promptTokens;
      baseComp += r.completionTokens;
      baseCost += r.costUsd;
      baseSteps.push({ step: i + 1, promptTokens: r.promptTokens, completionTokens: r.completionTokens, costUsd: r.costUsd });
      process.stdout.write(`\r  baseline  ${(i + 1).toString().padStart(2)}/${N}  prompt=${r.promptTokens.toString().padStart(5)}  cum=$${baseCost.toFixed(6)}`);
    } catch (e: any) {
      console.error(`\n  ⚠ step ${i + 1}: ${e.message}`);
      baseSteps.push({ step: i + 1, promptTokens: 0, completionTokens: 0, costUsd: 0 });
    }
    if (i < N - 1) await new Promise(r => setTimeout(r, 300));
  }
  console.log();

  // ── SKILL.state ──
  console.log("\n▸ SKILL.state (bounded O(1))...");
  const ss = await startProxy({
    listenPort: 0,
    upstreams: [{ name: "venice", url: VENICE_URL, apiKey: VENICE_KEY, priority: 0 }],
    stateDir: "/tmp/ss-bench-" + Date.now(),
    schema: ["step", "files_checked", "issues_found", "critical", "high", "medium", "low", "summary", "completed"],
    initialState: { step: 0, files_checked: [], issues_found: [], critical: 0, high: 0, medium: 0, low: 0, summary: "", completed: false },
    maxRetries: 2,
  });
  const sid = "venice-bench-" + Date.now();
  let ssPrompt = 0, ssComp = 0, ssCost = 0;
  const ssSteps: StepResult[] = [];

  for (let i = 0; i < N; i++) {
    const body = {
      model: MODEL, stream: false, max_tokens: 300, temperature: 0.3,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `Step ${i + 1}: ${TASKS[i % TASKS.length]}` }],
    };
    try {
      const r = await fetch(`http://127.0.0.1:${ss.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${VENICE_KEY}`, "x-skillstate-session": sid },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      ssPrompt += j.usage?.prompt_tokens ?? 0;
      ssComp += j.usage?.completion_tokens ?? 0;
      ssCost += j.cost?.usd ?? 0;
      ssSteps.push({ step: i + 1, promptTokens: j.usage?.prompt_tokens ?? 0, completionTokens: j.usage?.completion_tokens ?? 0, costUsd: j.cost?.usd ?? 0 });
      process.stdout.write(`\r  skillstate ${(i + 1).toString().padStart(2)}/${N}  prompt=${(j.usage?.prompt_tokens ?? 0).toString().padStart(5)}  cum=$${ssCost.toFixed(6)}`);
    } catch (e: any) {
      console.error(`\n  ⚠ step ${i + 1}: ${e.message}`);
      ssSteps.push({ step: i + 1, promptTokens: 0, completionTokens: 0, costUsd: 0 });
    }
    if (i < N - 1) await new Promise(r => setTimeout(r, 300));
  }
  console.log();
  ss.close();

  // ── Results ──
  const promptSaved = basePrompt - ssPrompt;
  const promptPct = basePrompt > 0 ? ((promptSaved / basePrompt) * 100).toFixed(1) : "N/A";
  const costSaved = baseCost - ssCost;
  const ratio200 = 200 / N;

  // Projected costs at paid provider rates
  const openaiBase = (basePrompt / 1e6) * 2.50 + (baseComp / 1e6) * 10.0;
  const openaiSS = (ssPrompt / 1e6) * 2.50 + (ssComp / 1e6) * 10.0;

  console.log(`
${"═".repeat(60)}
  RESULTS — ${N} steps on Venice (${MODEL})
${"═".repeat(60)}

  BASELINE:     ${basePrompt.toLocaleString()} prompt tokens · $${baseCost.toFixed(6)} actual
  SKILL.state:  ${ssPrompt.toLocaleString()} prompt tokens · $${ssCost.toFixed(6)} actual

  SAVINGS:      ${promptSaved.toLocaleString()} prompt tokens (${promptPct}%)
                $${costSaved.toFixed(6)} saved

  PROJECTED at 200 steps:
    baseline:  ~${Math.round(basePrompt * ratio200).toLocaleString()} prompt tokens
    skillstate: ~${Math.round(ssPrompt / N).toLocaleString()} tokens/step (constant)

  IF THIS WERE GPT-4o ($2.50/$10.00 per 1M):
    baseline:  $${openaiBase.toFixed(4)}
    skillstate: $${openaiSS.toFixed(4)}
    save:      $${(openaiBase - openaiSS).toFixed(4)}
${"═".repeat(60)}
`);

  // Per-step prompt growth
  console.log("  step  baseline  skillstate  ratio");
  console.log("  " + "─".repeat(40));
  for (const i of [0, 4, 9, 14, 19, 24, 29, N - 1]) {
    if (i < baseSteps.length && i < ssSteps.length) {
      const bp = baseSteps[i].promptTokens;
      const sp = ssSteps[i].promptTokens;
      console.log(`  ${(i + 1).toString().padStart(4)}  ${bp.toString().padStart(8)}  ${sp.toString().padStart(10)}  ${(bp / Math.max(sp, 1)).toFixed(1)}x`);
    }
  }
  console.log();
}

main().catch(e => { console.error(e); process.exit(1); });
