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

const API_KEY = process.env.SKILLSTATE_API_KEY;
const UPSTREAM = process.env.SKILLSTATE_UPSTREAM ?? "https://api.venice.ai/api/v1";
const MODEL = process.env.SKILLSTATE_MODEL ?? "qwen3-5-9b";
const N = Number(process.argv[2] ?? 20);

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

async function chat(url: string, messages: any[], extra: Record<string, string> = {}) {
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
      tools: TOOLS,
      tool_choice: "auto",
      messages,
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 240)}`);
  return JSON.parse(text);
}

function usage(j: any) {
  const p = j.usage?.prompt_tokens ?? 0;
  const c = j.usage?.completion_tokens ?? 0;
  return { p, c, usd: costFor(MODEL, p, c) };
}

async function runLoop(label: string, url: string, extra: Record<string, string>, bounded: boolean) {
  store.files.clear();
  store.findings.length = 0;
  const history: any[] = [
    {
      role: "system",
      content:
        "You are a security-review agent. Use record_finding and mark_file. Keep notes short. After tools, continue.",
    },
  ];
  let prompt = 0, comp = 0, usd = 0, toolCalls = 0;
  const steps: { step: number; prompt: number; tools: number }[] = [];

  for (let i = 0; i < N; i++) {
    const user = {
      role: "user",
      content: `Step ${i + 1}/${N}: review ${FILES[i % FILES.length]}. Call mark_file. If you see an issue, call record_finding.`,
    };
    const msgs = bounded ? [history[0], user] : [...history, user];
    if (!bounded) history.push(user);

    try {
    let j = await chat(url, msgs, extra);
    let u = usage(j);
    prompt += u.p; comp += u.c; usd += u.usd;
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
        const out = runTool(tc.function?.name, tc.function?.arguments ?? "{}");
        return { role: "tool", tool_call_id: tc.id, name: tc.function?.name, content: out };
      });
      const follow = bounded
        ? [history[0], user, msg, ...toolMsgs]
        : [...history, msg, ...toolMsgs];
      j = await chat(url, follow, extra);
      u = usage(j);
      prompt += u.p; comp += u.c; usd += u.usd;
      msg = { role: "assistant", content: j.choices?.[0]?.message?.content ?? "" };
    }

    if (!bounded) {
      history.push(msg);
    }
    steps.push({ step: i + 1, prompt: u.p, tools: toolsThis });
    process.stdout.write(`\r  ${label} ${(i + 1).toString().padStart(2)}/${N}  prompt=${u.p.toString().padStart(5)}  tools=${toolCalls}`);
    } catch (e: any) {
      console.error(`\n  ⚠ step ${i + 1}: ${e.message}`);
      steps.push({ step: i + 1, prompt: 0, tools: 0 });
    }
    if (i < N - 1) await new Promise((r) => setTimeout(r, 250));
  }
  console.log();
  return { prompt, comp, usd, toolCalls, steps, files: store.files.size, findings: store.findings.length };
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
  const sid = "tools-" + Date.now();
  const skill = await runLoop("skillstate", `http://127.0.0.1:${ss.port}/v1`, { "x-skillstate-session": sid }, true);
  ss.close();

  const saved = base.prompt - skill.prompt;
  const pct = base.prompt > 0 ? ((saved / base.prompt) * 100).toFixed(1) : "n/a";
  const gnk = gonkaCost(base.prompt + base.comp);
  const gnkSs = gonkaCost(skill.prompt + skill.comp);

  console.log(`
${"═".repeat(60)}
  TOOL-CALL RESULTS — ${N} steps · ${MODEL}
${"═".repeat(60)}
  BASELINE:     ${base.prompt.toLocaleString()} prompt · ${base.toolCalls} tool_calls · ${base.findings} findings
  SKILL.state:  ${skill.prompt.toLocaleString()} prompt · ${skill.toolCalls} tool_calls · ${skill.findings} findings
  SAVINGS:      ${saved.toLocaleString()} prompt tokens (${pct}%)
  GONKA est:    baseline ${gnk.gnk.toFixed(6)} GNK ($${gnk.usd.toFixed(6)})
                skillstate ${gnkSs.gnk.toFixed(6)} GNK ($${gnkSs.usd.toFixed(6)})
${"═".repeat(60)}
`);
}

main().catch((e) => { console.error(e); process.exit(1); });
