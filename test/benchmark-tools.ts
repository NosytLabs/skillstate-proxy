/**
 * Long-horizon tool-call agent vs append-only transcript.
 *
 * Each step the model may call record_finding / mark_file. The client
 * executes those locally and sends role:tool results back. Prompt tokens
 * come from upstream usage.
 *
 *   SKILLSTATE_API_KEY=... SKILLSTATE_UPSTREAM=https://api.venice.ai/api/v1 \
 *   SKILLSTATE_MODEL=qwen3-5-9b npx tsx test/benchmark-tools.ts 20
 */
import { startProxy } from "../src/proxy.js";
import { costFor, gonkaCost } from "../src/pricing.js";
import {
  backoffMs,
  contextGrowth,
  isRetryableStatus,
  perCallPrompt,
  verdict as computeVerdict,
  type ArmResult,
} from "./bench-harness.js";

const API_KEY = process.env.SKILLSTATE_API_KEY;
const UPSTREAM = process.env.SKILLSTATE_UPSTREAM ?? "https://api.venice.ai/api/v1";
const MODEL = process.env.SKILLSTATE_MODEL ?? "qwen3-5-9b";
const N = Number(process.argv[2] ?? 20);
// gonkaCost() returns usd:null unless a live GNK/USD rate is supplied. Pass one
// via SKILLSTATE_GNK_USD to get USD figures; otherwise report GNK only rather
// than crashing on null.
const GNK_USD =
  process.env.SKILLSTATE_GNK_USD !== undefined && process.env.SKILLSTATE_GNK_USD !== ""
    ? Number(process.env.SKILLSTATE_GNK_USD)
    : undefined;
const usdText = (usd: number | null): string =>
  usd === null ? "n/a (set SKILLSTATE_GNK_USD)" : `$${usd.toFixed(6)}`;

if (!API_KEY) {
  console.error("Set SKILLSTATE_API_KEY");
  process.exit(2);
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "record_finding",
      description: "Record a security finding. Call once per issue.",
      parameters: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          file: { type: "string" },
          note: { type: "string" },
        },
        required: ["severity", "file", "note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_file",
      description: "Mark a source file as reviewed.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
];

const FILES = [
  "src/auth/login.ts",
  "src/auth/session.ts",
  "src/auth/middleware.ts",
  "src/auth/tokens.ts",
  "src/auth/permissions.ts",
  "src/auth/oauth.ts",
  "src/auth/api-keys.ts",
  "src/auth/index.ts",
];

type Finding = { severity: string; file: string; note: string };
const store = { files: new Set<string>(), findings: [] as Finding[] };

function runTool(name: string, raw: string): string {
  let args: any = {};
  try { args = JSON.parse(raw || "{}"); } catch { args = { raw }; }
  if (name === "record_finding") {
    store.findings.push({
      severity: String(args.severity ?? "low"),
      file: String(args.file ?? "?"),
      note: String(args.note ?? "").slice(0, 200),
    });
    return JSON.stringify({ ok: true, count: store.findings.length });
  }
  if (name === "mark_file") {
    store.files.add(String(args.path ?? "?"));
    return JSON.stringify({ ok: true, reviewed: [...store.files] });
  }
  return JSON.stringify({ error: `unknown tool ${name}` });
}

// ── scenarios ────────────────────────────────────────────────────────────────
// One harness, several long-horizon workloads. SKILLSTATE_SCENARIO selects.
const RESEARCH_TOOLS = [
  {
    type: "function",
    function: {
      name: "note_source",
      description: "Record a claim together with the source it came from.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" }, claim: { type: "string" } },
        required: ["url", "claim"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_open_question",
      description: "Record a question the brief still needs answered.",
      parameters: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
      },
    },
  },
];

const EMAIL_TOOLS = [
  {
    type: "function",
    function: {
      name: "label_message",
      description: "Apply a triage label to an email.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string", enum: ["urgent", "action", "fyi", "spam", "archive"] },
        },
        required: ["id", "label"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "draft_reply",
      description: "Draft a reply body for an email that needs one.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, body: { type: "string" } },
        required: ["id", "body"],
      },
    },
  },
];

const SOURCES = [
  "https://arxiv.org/abs/2401.0001",
  "https://arxiv.org/abs/2402.0002",
  "https://openreview.net/forum?id=x1",
  "https://aclanthology.org/2024.x",
  "https://github.com/example/bench",
  "https://blog.example.com/long-context",
];
const MESSAGES = [
  "invoice-4471 from vendor@acme.example",
  "prod outage alert from pager@example",
  "newsletter from weekly@digest.example",
  "contract renewal from legal@bigco.example",
  "recruiter spam from jobs@spam.example",
  "customer escalation from vip@client.example",
];

const researchStore = { notes: [] as { url: string; claim: string }[], questions: [] as string[] };
const emailStore = { labels: [] as { id: string; label: string }[], drafts: [] as { id: string }[] };

type Scenario = {
  label: string;
  system: string;
  tools: any[];
  step: (i: number, n: number) => string;
  run: (name: string, args: any) => string;
  summary: () => string;
};

const SCENARIOS: Record<string, Scenario> = {
  security: {
    label: "security",
    system:
      "You are a security-review agent. Use record_finding and mark_file. Keep notes short. After tools, continue.",
    tools: TOOLS,
    step: (i, n) =>
      `Step ${i + 1}/${n}: review ${FILES[i % FILES.length]}. Call mark_file. If you see an issue, call record_finding.`,
    run: runTool,
    summary: () => `${store.findings.length} findings · ${store.files.size} files`,
  },
  research: {
    label: "research",
    system:
      "You are a research analyst building a sourced brief. Use note_source for each claim and add_open_question for gaps. Keep notes short. After tools, continue.",
    tools: RESEARCH_TOOLS,
    step: (i, n) =>
      `Step ${i + 1}/${n}: read ${SOURCES[i % SOURCES.length]} and call note_source with its key claim. If something is unresolved, call add_open_question.`,
    run: (name, args) => {
      if (name === "note_source") {
        researchStore.notes.push({
          url: String(args.url ?? "?"),
          claim: String(args.claim ?? "").slice(0, 200),
        });
        return JSON.stringify({ ok: true, notes: researchStore.notes.length });
      }
      if (name === "add_open_question") {
        researchStore.questions.push(String(args.question ?? "").slice(0, 160));
        return JSON.stringify({ ok: true, questions: researchStore.questions.length });
      }
      return JSON.stringify({ error: `unknown tool ${name}` });
    },
    summary: () => `${researchStore.notes.length} notes · ${researchStore.questions.length} open questions`,
  },
  email: {
    label: "email",
    system:
      "You are an inbox triage agent. Use label_message on every email, then draft_reply only when a reply is genuinely needed. Keep drafts short. After tools, continue.",
    tools: EMAIL_TOOLS,
    step: (i, n) =>
      `Step ${i + 1}/${n}: triage ${MESSAGES[i % MESSAGES.length]}. Call label_message. If it needs an answer, call draft_reply.`,
    run: (name, args) => {
      if (name === "label_message") {
        emailStore.labels.push({ id: String(args.id ?? "?"), label: String(args.label ?? "?") });
        return JSON.stringify({ ok: true, labelled: emailStore.labels.length });
      }
      if (name === "draft_reply") {
        emailStore.drafts.push({ id: String(args.id ?? "?") });
        return JSON.stringify({ ok: true, drafts: emailStore.drafts.length });
      }
      return JSON.stringify({ error: `unknown tool ${name}` });
    },
    summary: () => `${emailStore.labels.length} labelled · ${emailStore.drafts.length} drafts`,
  },
};

const SCENARIO_NAME = process.env.SKILLSTATE_SCENARIO ?? "security";
const SCENARIO = SCENARIOS[SCENARIO_NAME];
if (!SCENARIO) {
  console.error(
    `Unknown SKILLSTATE_SCENARIO '${SCENARIO_NAME}'. Use one of: ${Object.keys(SCENARIOS).join(", ")}`,
  );
  process.exit(2);
}

// Transient upstream failures (502 connect timeout, 503 circuit-open, 429) are
// common on the devshard. Without retries a SINGLE stall trips the proxy's
// circuit breaker and cascades into every later step failing — discarding a
// whole run. Retry with backoff so a brief blip doesn't invalidate the
// measurement; a step that exhausts its retries still counts as a real failure.
const RETRIES = Number(process.env.SKILLSTATE_RETRIES ?? 4);
const RETRY_BASE_MS = Number(process.env.SKILLSTATE_RETRY_BASE_MS ?? 3000);

async function chat(url: string, messages: any[], extra: Record<string, string> = {}) {
  let lastErr: Error = new Error("no attempt made");
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const r = await fetch(`${url}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${API_KEY}`,
          ...extra,
        },
        body: JSON.stringify({
          model: MODEL,
          stream: false,
          max_tokens: 400,
          temperature: 0.2,
          tools: SCENARIO.tools,
          tool_choice: "auto",
          messages,
        }),
      });
      const text = await r.text();
      if (!r.ok) {
        const err = new Error(`${r.status} ${text.slice(0, 240)}`);
        if (!isRetryableStatus(r.status)) throw err;
        lastErr = err;
      } else {
        if (attempt > 0) {
          process.stderr.write(`\n  ↻ recovered on attempt ${attempt + 1}\n`);
        }
        return JSON.parse(text);
      }
    } catch (e: any) {
      lastErr = e;
    }
    if (attempt < RETRIES) {
      const wait = backoffMs(attempt, RETRY_BASE_MS);
      process.stderr.write(
        `\n  ↻ ${String(lastErr.message).slice(0, 60)} — retry ${attempt + 1}/${RETRIES} in ${wait}ms`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function usage(j: any, label: string, step: number) {
  if (j.error && !j.choices) throw new Error(`${label} step ${step} error body: ${JSON.stringify(j).slice(0, 200)}`);
  if (j.usage?.prompt_tokens == null) throw new Error(`${label} step ${step} omitted usage — refusing silent 0`);
  const p = j.usage.prompt_tokens;
  const c = j.usage?.completion_tokens ?? 0;
  return { p, c, usd: costFor(MODEL, p, c) };
}

async function runLoop(label: string, url: string, extra: Record<string, string>, bounded: boolean) {
  store.files.clear();
  store.findings.length = 0;
  researchStore.notes.length = 0;
  researchStore.questions.length = 0;
  emailStore.labels.length = 0;
  emailStore.drafts.length = 0;
  const history: any[] = [
    {
      role: "system",
      content: SCENARIO.system,
    },
  ];
  let prompt = 0, comp = 0, usd = 0, toolCalls = 0, apiCalls = 0, failures = 0;
  const steps: { step: number; prompt: number; tools: number }[] = [];

  for (let i = 0; i < N; i++) {
    const user = {
      role: "user",
      content: SCENARIO.step(i, N),
    };
    const msgs = bounded ? [history[0], user] : [...history, user];
    if (!bounded) history.push(user);

    try {
    let j = await chat(url, msgs, extra);
    let u = usage(j, label, i + 1);
    prompt += u.p; comp += u.c; usd += u.usd; apiCalls += 1;
    let toolsThis = 0;
    let msg = j.choices?.[0]?.message ?? {};
    const calls = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.filter((tc: any) => tc?.function?.name && tc.id)
      : [];
    if (calls.length) msg = {
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: calls.map((tc: any) => ({
        id: String(tc.id),
        type: "function",
        function: {
          name: String(tc.function.name),
          arguments: typeof tc.function.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments ?? {}),
        },
      })),
    };
    else {
      msg = { role: "assistant", content: msg.content ?? "" };
    }

    // one tool round-trip per step (real agent loop)
    if (calls.length) {
      const toolMsgs = calls.map((tc: any) => {
        toolsThis += 1;
        toolCalls += 1;
        const out = SCENARIO.run(tc.function?.name, (() => {
          try { return JSON.parse(tc.function?.arguments ?? "{}"); } catch { return {}; }
        })());
        return { role: "tool", tool_call_id: tc.id, name: tc.function?.name, content: out };
      });
      const follow = bounded
        ? [history[0], user, msg, ...toolMsgs]
        : [...history, msg, ...toolMsgs];
      j = await chat(url, follow, extra);
      u = usage(j, label, i + 1);
      prompt += u.p; comp += u.c; usd += u.usd; apiCalls += 1;
      msg = { role: "assistant", content: j.choices?.[0]?.message?.content ?? "" };
    }

    if (!bounded) {
      history.push(msg);
    }
    steps.push({ step: i + 1, prompt: u.p, tools: toolsThis });
    process.stdout.write(`\r  ${label} ${(i + 1).toString().padStart(2)}/${N}  prompt=${u.p.toString().padStart(5)}  tools=${toolCalls}`);
    } catch (e: any) {
      failures += 1;
      console.error(`\n  ⚠ step ${i + 1}: ${e.message}`);
      steps.push({ step: i + 1, prompt: 0, tools: 0 });
    }
    if (i < N - 1) await new Promise((r) => setTimeout(r, 250));
  }
  console.log();
  return { prompt, comp, usd, toolCalls, apiCalls, failures, steps, files: store.files.size, findings: store.findings.length };
}

async function main() {
  console.log(`\nSKILL.state tool-call bench · ${N} steps · ${MODEL}`);
  console.log(`upstream ${UPSTREAM}\n`);

  console.log("▸ BASELINE (growing transcript + tools)...");
  const base = await runLoop("baseline", `${UPSTREAM}`, {}, false);

  const ss = await startProxy({
    listenPort: 0,
    upstreams: [{ name: "upstream", url: UPSTREAM, apiKey: API_KEY!, priority: 0 }],
    stateDir: "/tmp/ss-tools-" + Date.now(),
    schema: ["step", "files_checked", "issues_found", "summary"],
    initialState: { step: 0, files_checked: [], issues_found: [], summary: "" },
    maxRetries: 2,
  });
  console.log("\n▸ SKILL.state (bounded + tools)...");
  const sid = "tools-" + crypto.randomUUID().slice(0, 8);
  const skill = await runLoop("skillstate", `http://127.0.0.1:${ss.port}/v1`, { "x-skillstate-session": sid }, true);
  ss.close();

  const saved = base.prompt - skill.prompt;
  const pct = base.prompt > 0 ? ((saved / base.prompt) * 100).toFixed(1) : "n/a";
  const gnk = gonkaCost(base.prompt + base.comp, GNK_USD);
  const gnkSs = gonkaCost(skill.prompt + skill.comp, GNK_USD);

  // All validity/metric maths lives in bench-harness.ts so it is unit-tested —
  // these are the values that silently went wrong twice before.
  const v = computeVerdict(base as ArmResult, skill as ArmResult);
  const valid = v.valid;
  const fair = v.fairRaw;
  const invalidBanner = v.banner;
  const avgPct = v.perCallDeltaPct;
  const baseAvg = perCallPrompt(base as ArmResult);
  const ssAvg = perCallPrompt(skill as ArmResult);

  console.log(`${invalidBanner}
${"═".repeat(60)}
  TOOL-CALL RESULTS — ${N} steps · ${MODEL} · scenario=${SCENARIO.label}${valid ? "" : "  [INVALID]"}
${"═".repeat(60)}
  BASELINE:     ${base.prompt.toLocaleString()} prompt · ${base.apiCalls} upstream calls (${base.toolCalls} tool_calls) · ${base.findings} findings · ${base.failures} failed
  SKILL.state:  ${skill.prompt.toLocaleString()} prompt · ${skill.apiCalls} upstream calls (${skill.toolCalls} tool_calls) · ${skill.findings} findings · ${skill.failures} failed
  RAW SAVINGS:  ${saved.toLocaleString()} prompt tokens (${pct}%)   <-- only meaningful when call counts match

  PER-CALL (the fair, workload-independent metric):
    baseline    ${baseAvg.toFixed(0)} prompt tokens/call
    skillstate  ${ssAvg.toFixed(0)} prompt tokens/call   (${avgPct >= 0 ? "-" : "+"}${Math.abs(avgPct).toFixed(1)}%)
  CONTEXT GROWTH (first->last step):
    baseline    ${contextGrowth(base.steps).toFixed(2)}x
    skillstate  ${contextGrowth(skill.steps).toFixed(2)}x
  ${fair ? "" : "NOTE: arms made different numbers of calls, so RAW SAVINGS is NOT a like-for-like\n        comparison — read PER-CALL and CONTEXT GROWTH instead.\n"}
  GONKA est:    baseline ${gnk.gnk.toFixed(6)} GNK (${usdText(gnk.usd)})
                skillstate ${gnkSs.gnk.toFixed(6)} GNK (${usdText(gnkSs.usd)})
${"═".repeat(60)}
`);
}

main().catch((e) => { console.error(e); process.exit(1); });
