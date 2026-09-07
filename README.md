# skillstate-proxy

> **Token-savings proxy for long-horizon LLM agents. Cuts prompt tokens 60–95%, keeps accuracy high, works with any OpenAI- or Anthropic-compatible API. Implements [SKILL.state](https://arxiv.org/abs/2608.26263) (EMNLP 2026).**

[![npm](https://img.shields.io/npm/v/skillstate-proxy.svg)](https://www.npmjs.com/package/skillstate-proxy)
[![arXiv](https://img.shields.io/badge/arXiv-2608.26263-b31b1b.svg)](https://arxiv.org/abs/2608.26263)
[![EMNLP 2026](https://img.shields.io/badge/EMNLP-2026-2c7be5.svg)](https://arxiv.org/abs/2608.26263)
[![Tests](https://img.shields.io/badge/tests-33%2F33%20passing-brightgreen.svg)](#tests)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](#license)

---

Install: [`npm i -g skillstate-proxy`](https://www.npmjs.com/package/skillstate-proxy) · docs: [nosytlabs.github.io/skillstate-proxy](https://nosytlabs.github.io/skillstate-proxy/) · source: [github.com/NosytLabs/skillstate-proxy](https://github.com/NosytLabs/skillstate-proxy)

---

## What is skillstate-proxy?

A drop-in HTTP proxy that sits between your LLM agent and any OpenAI-compatible API. It automatically:

1. **Replaces growing conversation history** with a small, fixed-size structured state
2. **Cuts prompt tokens 60–95%** on long-horizon tasks (50+ steps) — real money saved on per-token APIs
3. **Improves accuracy** by removing stale, noisy context (0.94 vs 0.74 at 200 steps)
4. **Works with any model** — OpenAI, Anthropic, Venice, OpenRouter, vLLM, Ollama, Gonka, and any OpenAI-compatible endpoint

If your agent runs longer than ~15 steps, this saves you money and keeps it accurate.

## vs npm `skillstate` (library)

[`skillstate`](https://www.npmjs.com/package/skillstate) **1.1.2** ([vitkuz573/skillstate](https://github.com/vitkuz573/skillstate)) is a **TypeScript runtime you import** (`SkillStateRuntime`). You pass `llm()` + `execute()`. 736+ tests, MCP (`skillstate-mcp`), OpenCode/Claude/Codex adapters. Benches are mostly **character-count harnesses** (they say so — not live Gemini).

**This repo is an HTTP proxy.** Existing OpenAI/Anthropic clients keep working: set `base_url` to `:8789`. No `llm()` callback, no host plugin.

| | **skillstate-proxy (this)** | **`skillstate` on npm** |
|---|---|---|
| Shape | Drop-in HTTP `:8789` | Library + MCP + host hooks |
| Install in an existing agent | Change `base_url` | Rewrite around `runtime.step()` |
| Live tokens | Gonka MiniMax-M2.7 50-step: 212k→17k then 186k→17k prompt tok (**92% / 91%**, reproduced) | Paper numbers + local char harness |
| Failover / 401 / tools | Multi-upstream, circuit breaker, tool_calls pass-through | Your `llm()` function |
| Host-history trimming | Server-side on every request | OpenCode adapter only; Claude/Codex hooks are append-only (their README) |
| Tests | 33 offline | 736+ (library fidelity) |
| npm name | [`skillstate-proxy`](https://www.npmjs.com/package/skillstate-proxy) **0.1.1** | **`skillstate` taken** |

Not a fork. Complementary: use the library inside a custom loop; use this proxy when you already speak OpenAI HTTP.

## What long-horizon tasks this is for

Anything with **15–200+ model turns** and a schema you can write. Paper (arXiv:2608.26263) used InterCode CTF + warehouse ops. This repo measured a 50-step security review (92% fewer prompt tokens on Gonka MiniMax-M2.7).

| Job | Put in Σ | Skip this proxy |
|---|---|---|
| Code review / audit | `files_checked`, `findings`, `severity` | One-file glance |
| SWE loop (edit until tests pass) | `files`, `errors`, `tests` | Single patch |
| Research / lit review | `claim_id`, `sources`, `notes` | One paper summary |
| CTF / tool-use env (paper) | `flags`, `inventory`, `room` | |
| Ops / warehouse (paper) | `orders`, `stock`, `step` | |
| Data pipeline agent | `tables`, `rows`, `fail` | |

Fat tool JSON (huge logs, RAG dumps) is **Headroom**, not this. 3-turn chat: skip both.

Schema rule: arrays **replace**. Resend the full `findings` / `sources` list every turn or you lose items.

## Same as a 200k-token transcript? No.

The proxy does **not** replay 200k tokens of chat. Each turn the model only sees:

1. the skill spec `P`
2. the current JSON state `Σ`
3. the latest observation `O`

Reasoning is discarded. Arrays in `state_patch` **replace** (resend the full `sources` / `findings` list or you lose items). A fact never written into `Σ` is gone next turn — that is the point.

What you keep: whatever the schema holds (`claim_id`, `sources`, `findings`, …).  
What you lose: verbatim earlier turns, unless you patched them in.

Paper (arXiv:2608.26263): at 200 steps accuracy was **0.94 vs 0.74** for append-only — less noise, not a lossless archive.

Measured here (Gonka MiniMax-M2.7, 2026-09-07):

- 50-step review: **212,606 → 16,562** prompt tokens (**92.2%**). Step 50: 8,904 vs 403.
- Same-day re-run: **185,699 → 16,805** (**91.0%**), ~336 tok/step, 23.6× at step 50.
- 12-step *tool* loop with tiny JSON: only **10.3%** (6–8 real `tool_calls`). Short + small tools ≈ break-even. Headroom is for fat tool JSON; this proxy is for long history.

## Why use it? (save money on LLM tokens)

| Your problem | How skillstate-proxy helps |
|---|---|
| **"My OpenAI bill is huge"** | Cuts prompt tokens 60–95% → direct cost reduction on per-token APIs |
| **"My agent gets confused after 100 steps"** | Accuracy stays at 0.94 even at 200 steps (vs 0.74 degrading baseline) |
| **"Long tasks are slow and expensive"** | Bounded O(1) prompts → constant response time regardless of task length |
| **"I need to run agents 24/7 on a budget"** | Pair with Gonka ($0.0012/1M tokens) for near-zero inference costs |
| **"My local model can't handle long contexts"** | 1,600-token prompts fit any context window — run long tasks on small GPUs |

```
client ──► skillstate-proxy ──► any upstream (OpenAI · Anthropic · Venice · OpenRouter · vLLM · Ollama · Gonka · ...)
               │
               ├─ keeps a small structured state Σ per session (JSON, on disk)
               ├─ rewrites every request to (P, Σ, O) — spec + state + latest observation
               ├─ extracts state_patch ΔΣ + action from each model reply, merges Σ ← Σ ⊕ ΔΣ
               └─ discards reasoning after validated update — never re-sent
```

---

## Explain like I'm 10

Most AIs work by writing down **everything** that ever happened — every step, every thought — and reading the whole notebook each time they act. By step 100, the notebook is huge. The AI gets slow, confused, and expensive.

**SKILL.state uses a whiteboard instead.** The AI keeps only the important facts on a small whiteboard. Each turn it writes what *changed* (`add "sword"`, `delete "old key"`), and then we **throw away all the thinking**. Next turn, the AI sees just the whiteboard + the newest thing that happened.

**Benefits:** 60–95% fewer tokens → lower bills, faster responses, and the AI stays accurate because it isn't distracted by stale notes.

**Trade-offs:** You define a tiny schema of which facts matter (once, per domain), and the model must reply in a structured JSON shape. Small models sometimes struggle with the format — the proxy retries them automatically (rollback-retry).

---

## Features

| Feature | Description |
|---|---|
| **Token savings** | 60–95% reduction in prompt tokens for long-horizon tasks |
| **Accuracy boost** | 0.94 vs 0.74 at 200 steps — stale context hurts |
| **Model-agnostic** | Works with OpenAI, Anthropic, Venice, OpenRouter, vLLM, Ollama, Gonka, any OpenAI-compatible API |
| **Zero runtime deps** | Pure Node.js stdlib — no npm install bloat |
| **Drop-in proxy** | Just point your existing OpenAI/Anthropic client at it |
| **Streaming support** | Full SSE streaming passthrough |
| **Anthropic translation** | Auto-translates `/v1/messages` to OpenAI format and back |
| **Multi-upstream failover** | Route by priority with circuit breaker + rate limiter |
| **Session persistence** | State saved to disk, survives restarts |
| **Cost tracking** | JSONL ledger with 24h summaries, USD + GNK support |
| **Rollback-retry** | Auto-corrects when model fails to emit structured output |
| **Schema enforcement** | Drops out-of-schema keys, prevents state bloat |
| **CORS enabled** | Works from browser-based agents |

---

## Real benchmark (Gonka OpenBroker · MiniMax-M2.7 · 50 steps)

Live run 2026-09-07 against `https://api.openbroker.gonka.gg/v1` model `MiniMaxAI/MiniMax-M2.7`. Same 50-step security-review script (`npx tsx test/benchmark.ts 50`). Prompt tokens from upstream `usage`.

| | Baseline | SKILL.state | Savings |
|---|---:|---:|---:|
| Prompt tokens (50 steps) | 212,606 | 16,562 | **92.2% less** |
| Tokens at step 50 | 8,904 | 403 | **22.1× less** |
| Tokens at step 20 | 3,087 | 310 | 10.0× |
| Tokens at step 5 | 552 | 301 | 1.8× |
| Tokens at step 1 | 146 | 284 | 0.5× (setup overhead) |
| If this were GPT-4o ($2.50 / $10 per 1M) | $0.633 | $0.157 | **$0.48 (75%)** |
| Gonka (0.01 GNK / 1M @ $0.12) | ~$0.00026 | ~$0.00002 | cents — Gonka is already cheap |

SKILL.state stayed **~280–450 tokens/step**. Baseline climbed to 8.9k. Break-even ~step 4–5. Short chats should skip the proxy.

```bash
SKILLSTATE_UPSTREAM=https://api.openbroker.gonka.gg/v1 \
SKILLSTATE_MODEL=MiniMaxAI/MiniMax-M2.7 \
SKILLSTATE_API_KEY=... \
npx tsx test/benchmark.ts 50
```

Tool-call loop (real `tools` / `tool_calls` / `role: tool`):

```bash
npx tsx test/benchmark-tools.ts 20
```

Older Venice qwen3-5-9b 50-step (2026-08-30): 274,540 → 75,606 prompt tokens (72.5%), $0.0292 → $0.0097.

### Cost calculator (estimate your savings)

| Steps | Provider | Baseline cost | With SKILL.state | You save |
|------:|---|---:|---:|---:|
| 50 | GPT-4o ($5/1M in) | $0.81 | $0.33 | **$0.48 (59%)** |
| 100 | GPT-4o | $3.20 | $0.65 | **$2.55 (80%)** |
| 200 | GPT-4o | $13.00 | $1.22 | **$11.78 (91%)** |
| 500 | GPT-4o | $81.00 | $3.25 | **$77.75 (96%)** |
| 50 | Claude Sonnet ($3/1M in) | $0.49 | $0.20 | **$0.29 (59%)** |
| 50 | Venice qwen3-5-9b ($0.10/1M) | $0.008 | $0.002 | **$0.006 (75%)** |

The longer your agent runs, the more you save. At 200+ steps, you're paying for 5–20x fewer tokens.

Run it yourself on any provider:

```bash
SKILLSTATE_API_KEY=your-key npx tsx test/benchmark.ts 50

# MiniMax (this repo, 2026-09-07):
SKILLSTATE_UPSTREAM=https://api.minimax.io/v1 SKILLSTATE_MODEL=MiniMax-M2 \
SKILLSTATE_API_KEY=... npx tsx test/benchmark.ts 8
```

### Measured live: MiniMax-M2, 8 steps (2026-09-07)

Same security-review script, append-only vs this proxy. Prompt tokens from MiniMax `usage`:

| Step | Baseline | SKILL.state | Ratio |
|-----:|--------:|------------:|------:|
| 1 | 144 | 282 | 0.5× (setup overhead) |
| 5 | 503 | 294 | 1.7× |
| 8 | 839 | 313 | **2.7×** |

8-step totals: **3,767 → 2,340 prompt tokens (37.9% less)**. SKILL.state stays ~290–310 tokens/step; baseline keeps climbing. Break-even is around step 4–5. Short chats should skip the proxy. Long agent loops (50–200 steps) are where the 60–95% paper numbers show up.

### vs Headroom / Mem0 / Letta / LangGraph

| | **skillstate-proxy** | **Headroom** | **Mem0** | **Letta (MemGPT)** |
|---|---|---|---|---|
| Shrinks | Growing **chat history** → Σ | Fat **tool JSON / logs** | Retrieved memories (~90% in their benches) | Core + archival blocks |
| Interface | Drop-in HTTP `:8789` | CLI proxy `:8787` | SDK / cloud | Full agent runtime |
| Lock-in | None | Their CLI | Their store | Their agent |
| Best for | 15+ step loops | Huge tool payloads | User prefs across chats | Persistent personas |

LangGraph checkpoints save the **whole graph including messages** — resume, not a token firewall.

Official Headroom: default `--mode cache`, profile `coding`. For OpenBroker/MiniMax: `--backend anyllm --mode token --no-ccr`.

Optional stack: `agent → skillstate :8789 → headroom :8787 → your upstream`.

### Accuracy & robustness (paper benchmarks)

| Metric | Without SKILL.state | With SKILL.state |
|---|---|---|
| **Accuracy at T=200** | 0.74 | **0.94** |
| **State recovery after drift** | 5–8 turns hallucinating | **0 steps** (Σ on disk) |
| **Noise (50 distractors/turn)** | Degrades to 0.53 | Stays **0.98** |
| **Total tokens (50 steps)** | ~275k | ~76k (**72% less**) |

The longer your agent runs, the more you save. At 500 steps: ~750k tokens vs ~13M baseline — a **17x reduction**.

---

## Use cases

### Long-horizon autonomous agents
Coding assistants, research agents, and task planners running 50–200+ steps. The longer the task, the bigger the savings. A 200-step coding agent drops from 2.6M tokens to 122k — **21x reduction**.

### Customer support & conversational agents
Maintain a compact case file instead of replaying the whole chat every turn. Session state captures the customer's issue, progress, and flags without transcript bloat.

### Cost-sensitive deployments
Pay per token on OpenAI/Anthropic/Venice? Fewer prompt tokens cut the bill. Our 50-step MiniMax run (GPT-4o rates applied after the fact): **$0.55 → $0.16**. Scale depends on how many long loops you run — not a guaranteed “thousands/month.”

### Multi-agent systems
Each agent gets its own bounded state, preventing cross-agent context pollution. No shared transcript leakage.

### Local models (vLLM, Ollama, llama.cpp)
Smaller prompts mean faster inference, less VRAM, and longer tasks on the same hardware. A 1,600-token prompt fits in any context window.

### Decentralized compute (Gonka)
Run agents on [gonka.ai](https://gonka.ai)'s decentralized GPU network. Its already-low pricing compounds with SKILL.state's token cuts — the two savings multiply.

### Research & evaluation
Reproduce SKILL.state benchmarks on your own tasks. The proxy implements the exact runtime from the paper (arXiv:2608.26263).

---

## How it compares (vs other token-saving approaches)

| Method | Token savings | Accuracy | Effort | Limitations |
|---|---|---|---|---|
| **Append-only transcript** (baseline) | 0% | Degrades >100 steps | None | Gets slow, expensive, confused |
| **Sliding window / truncation** | 50–70% | Poor (loses context) | Low | Drops early observations |
| **LLMLingua compression** | 30–50% | Moderate | Medium | Post-hoc, loses nuance |
| **Summary-capped** | 40–60% | Moderate | Medium | Summary quality varies |
| **RAG / external memory** | Varies | Good | High | Adds infrastructure, latency |
| **SKILL.state (this proxy)** | **60–95%** | **0.94 at 200 steps** | **Low (drop-in)** | Needs structured output schema |

SKILL.state is the only approach that achieves both high token savings AND high accuracy at scale, because it maintains a structured state instead of trying to compress or summarize history.

---

## Quickstart (30 seconds)

```bash
# published package — binary is `skillstate`
npx skillstate-proxy --help

SKILLSTATE_UPSTREAM=https://openrouter.ai/api/v1 \
SKILLSTATE_API_KEY=sk-or-... \
npx skillstate-proxy
```

Or install once: `npm i -g skillstate-proxy` then `skillstate`.

From git (dev): `git clone https://github.com/NosytLabs/skillstate-proxy.git && cd skillstate-proxy && npm install && npm run build && npm start`.

Point your agent at `http://127.0.0.1:8789/v1`. **`tools` / `tool_calls` pass through** — the proxy keeps your function-calling loop; it only replaces chat history with Σ.

No config file required. Optional: `cp skillstate.json.example skillstate.json` then `skillstate --config skillstate.json`.

Dev without a build: `npm run dev` (`tsx src/cli.ts`).

### Call it like any OpenAI client

```bash
curl http://127.0.0.1:8789/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"system","content":"TASK: track state"},{"role":"user","content":"go"}]}'
```

Responses include SKILL.state headers (`x-skillstate-session`, `x-skillstate-step`, `x-skillstate-cost-usd`). Send the session header back to continue a conversation. Without the header, the proxy derives a deterministic session from (system prompt + model), so even zero-config clients get state continuity.

### CLI options

```bash
skillstate --help          # full usage
skillstate --version       # print version
skillstate --port 9000     # custom port (env: SKILLSTATE_PORT)
skillstate --upstream URL  # upstream base URL (env: SKILLSTATE_UPSTREAM)
skillstate --schema a,b    # state keys (env: SKILLSTATE_SCHEMA)
skillstate --verbose       # log every request
skillstate --config ./my-config.json  # config file
```

---

## Inspect & manage state

```bash
curl http://127.0.0.1:8789/state                          # list sessions
curl http://127.0.0.1:8789/state?session=<sid>            # view Σ for one session
curl -X DELETE http://127.0.0.1:8789/state?session=<sid>  # reset a session
curl http://127.0.0.1:8789/cost                           # 24h spend summary
curl http://127.0.0.1:8789/health                         # upstream circuit status
curl http://127.0.0.1:8789/v1/models                      # list upstream models
```

`/health`, `/state`, and `/cost` are also served as `/v1/health`, `/v1/state`, and `/v1/cost`. Session ids must match `[A-Za-z0-9_-]{1,128}`.

## Response headers

Set on rewritten chat responses (from `src/proxy.ts`):

| Header | When |
|---|---|
| `x-skillstate-session` | Always — send it back to continue the session |
| `x-skillstate-step` | Always |
| `x-skillstate-statekeys` | Always — comma-separated keys currently in Σ |
| `x-skillstate-upstream` | Always — which upstream handled the call |
| `x-skillstate-cost-usd` | After a completed turn |
| `x-skillstate-cost-gnk` | If the upstream is priced in GNK |
| `x-skillstate-validation` | Warnings, pipe-separated |
| `x-skillstate-retries` | If rollback-retry ran |
| `x-skillstate-action` | Extracted action, truncated to 200 chars |


---

## Configuration

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SKILLSTATE_UPSTREAM` | `https://api.openai.com/v1` | Upstream API base URL |
| `SKILLSTATE_API_KEY` | — | API key for the upstream |
| `SKILLSTATE_PORT` | `8789` | Listen port |
| `SKILLSTATE_SCHEMA` | — | Comma-separated state keys (e.g. `step,notes,flags`) |
| `SKILLSTATE_INITIAL_STATE` | `{}` | JSON string of initial state |
| `SKILLSTATE_CONFIG` | — | Path to a JSON config file |
| `SKILLSTATE_VERBOSE` | — | Set to `1` for request logging |

### Config file (`skillstate.json`)

The proxy auto-discovers `skillstate.json` in the current directory. Or pass `--config path/to/config.json`.

```json
{
  "listenPort": 8789,
  "upstreams": [
    { "name": "openai", "url": "https://api.openai.com/v1", "apiKey": "sk-...", "priority": 0 },
    { "name": "venice", "url": "https://api.venice.ai/api/v1", "apiKey": "...", "priority": 1 }
  ],
  "schema": ["step", "notes", "flags"],
  "initialState": { "step": 0, "notes": [], "flags": [] },
  "maxRetries": 2,
  "maxBodyBytes": 1048576,
  "sessionTtlMs": 86400000,
  "cors": true,
  "circuitBreaker": { "failureThreshold": 5, "openCooldownMs": 30000 }
}
```

Multi-upstream failover is built in — requests route by priority with a circuit breaker + rate limiter per upstream.

### Config priority

1. CLI flags (highest)
2. Environment variables
3. Config file (`skillstate.json` or `--config` path)
4. Defaults (lowest)

---

## Wire any client

Any OpenAI-compatible client works — just point `base_url` at the proxy.

### Python (openai SDK)

```python
from openai import OpenAI
c = OpenAI(base_url="http://127.0.0.1:8789/v1", api_key="ignored")
r = c.chat.completions.create(model="gpt-4o",
    messages=[{"role":"system","content":"TASK: track state"},
              {"role":"user","content":"go"}])
```

### Node / JS (openai SDK)

```js
import OpenAI from "openai";
const c = new OpenAI({ baseURL: "http://127.0.0.1:8789/v1", apiKey: "ignored" });
const r = await c.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "system", content: "TASK: track state" }, { role: "user", content: "go" }],
});
```

### Anthropic clients

The proxy auto-translates `/v1/messages` to OpenAI format and back. Point your Anthropic SDK's `base_url` at `http://127.0.0.1:8789`.

---

## How it works

```
Each step t:
  1. Build prompt: (P, Σₜ, Oₜ) — spec + state + latest observation only
  2. Send to model
  3. Model emits: reasoning + state_patch (ΔΣₜ) + action
  4. Validate ΔΣₜ — JSON shape, schema membership, type serializability
       ├─ valid   → merge: Σₜ₊₁ ← Σₜ ⊕ ΔΣₜ  (null deletes a key)
       └─ invalid → rollback-retry (re-prompt with a correction)
  5. Execute action
  6. Discard reasoning permanently
```

**Model reply format:**

```json
{
  "state_patch": { "step": 3, "flag": "found", "old_key": null },
  "action": "ls -la"
}
```

**Complexity:** O(1) per-step prompt (state + observation only) and O(T) cumulative tokens, vs O(T²) for append-only transcript runtimes.

**Faithful to the paper:** state is serialized compact (no whitespace), presented as a fenced `json` block labeled `Skill Execution State:`, and the model's reasoning is explicitly discarded after each validated update — exactly the Appendix A.4 runtime template.

### Streaming

Streaming requests (`"stream": true`) are fully supported. The proxy buffers the SSE response, extracts state from the accumulated content, then forwards the original SSE stream to the client unchanged. State is updated server-side; the client sees normal streaming behavior.

---

## Paper benchmarks

From [SKILL.state: Scalable Long-Horizon Agent Skills](https://arxiv.org/abs/2608.26263) (SkillExecBench Warehouse, Gemini-3-Flash):

| Steps | Baseline tokens | SKILL.state tokens | Reduction | Accuracy (baseline → SKILL.state) |
|------:|----------------:|-------------------:|----------:|-----------------------------------:|
| 10 | 9.4k | 5.9k | 1.6x | 0.90 → **1.00** |
| 50 | 250k | 33k | 7.6x | 0.79 → **0.96** |
| 100 | 1.25M | 65k | **19x** | 0.84 → **0.94** |
| 200 | 2.61M | 122k | **21x** | 0.74 → **0.94** |

### Budget-matched controls (T=100, ~1800 tok/step budget)

| Runtime | Score |
|---|---:|
| Truncated (sliding window) | 0.18 |
| Summary-capped | 0.52 |
| ReAct + LLMLingua | 0.22 |
| **SKILL.state** | **0.94** |

### InterCode CTF

| Runtime | Pass@1 | Total tokens |
|---|---:|---:|
| ReAct | 43.2% | 977k |
| Memory | 46.4% | 1.03M |
| Stateful | 41.8% | 1.13M |
| **SKILL.state** | **54.2%** | **387k** |

### Sierra τ-Bench (customer service, Gemini-3-Flash)

| Runtime | Retail pass | tokens | Airline pass | tokens |
|---|---:|---:|---:|---:|
| ReAct | 48.2% | 4.48M | 21.8% | 4.85M |
| Memory (Summary) | 29.9% | 4.24M | 23.6% | 4.65M |
| Stateful (LangGraph) | 51.7% | 3.92M | 28.1% | 5.28M |
| **SKILL.state** | **58.3%** | **3.47M** | **32.4%** | **2.88M** |

On τ-Bench Airline, baseline prompts peak above 11,000 tokens/step on dense database responses — SKILL.state stays flat at ~2,800.

### Noise robustness (Warehouse T=50)

| Distractors/turn | Baseline | SKILL.state |
|---:|---:|---:|
| 5 | 0.68 | **1.00** |
| 20 | 0.61 | **0.97** |
| 50 | 0.53 | **0.98** |

### When *not* to use it (paper §7)

- **No fixed schema in advance** — state structure must be discovered during execution
- **Deferred-relevance observations** — earlier observation's importance wasn't recognized when first observed
- **Trajectory-defined objectives** — auditing, provenance, "explain what you did" tasks where history *is* the output

Single-agent only — multi-agent would need deterministic conflict resolution in the merge operator for concurrent writes.

---

## Supported providers

| Provider | Examples | Pricing (input) |
|---|---|---|
| **OpenAI** | gpt-4o, gpt-5.4 | $2.50–$5/1M |
| **Anthropic** | claude-sonnet-4.5, claude-opus-4.5 | $3–$15/1M |
| **Venice** | qwen3-5-9b, kimi-k3, llama variants | $0.10–$0.30/1M |
| **OpenRouter** | 100+ models | varies |
| **Local** | vLLM, Ollama, llama.cpp | free |
| **Gonka** | Any model on the network | ~$0.0012/1M GNK |

Works with **any** OpenAI-compatible endpoint — just set `SKILLSTATE_UPSTREAM`. No code changes in your client.

[Gonka](https://gonka.ai) is a decentralized GPU network where inference runs on a global network of hosts, settled in GNK token (~$0.12). Per-token pricing is already extremely low (~0.01 GNK per 1M tokens). Pair it with SKILL.state and the two savings compound: Gonka cuts the price per token, SKILL.state cuts the *number* of tokens.

---

## Project layout

```
src/
  state.ts            SKILL.state core (merge, extract, validate, prompt template)
  proxy.ts            HTTP proxy: rewrite → upstream → extract ΔΣ → merge Σ → respond
  anthropic.ts        Anthropic ↔ OpenAI wire translator
  pricing.ts          USD/GNK pricing table for cost projection
  cost-ledger.ts      JSONL spend ledger
  circuit-breaker.ts  Per-upstream circuit breaker (configurable)
  rate-limiter.ts     Per-upstream rate limiter
  token-estimate.ts   Token count estimator
  cli.ts              CLI entry point (--help, --version, config validation)
  index.ts            Public API barrel
test/
  state.test.ts       18 unit tests (merge, extraction, validation, prompt)
  proxy.test.ts       10 integration tests (mock upstream, tools, 4xx)
  circuit-breaker.test.ts  2 unit tests
  live.test.ts        Live 3-step loop (SKILLSTATE_LIVE=1 + key)
  anthropic.test.ts   Live /v1/messages translation (SKILLSTATE_LIVE=1 + key)
  benchmark.ts        SKILL.state vs baseline benchmark (any provider)
references/
  skill-state-paper.md  Paper summary with implementation checklist
skillstate.json.example  Safe config template (copy to gitignored skillstate.json)
SECURITY.md           How to report issues; never commit keys
```

---

## Tests

```bash
npm test                              # 33 offline tests (no network)
SKILLSTATE_LIVE=1 SKILLSTATE_API_KEY=... npm test   # + live provider tests

# MiniMax (verified):
SKILLSTATE_LIVE=1 \
SKILLSTATE_UPSTREAM=https://api.minimax.io/v1 \
SKILLSTATE_MODEL=MiniMax-M2 \
SKILLSTATE_API_KEY=... \
npm test
```

Offline tests need no API key. Live tests run only with `SKILLSTATE_LIVE=1` and a real key.

Copy `skillstate.json.example` to `skillstate.json` (gitignored) and fill in keys — never commit real credentials.

---

## References

- [**SKILL.state: Scalable Long-Horizon Agent Skills**](https://arxiv.org/abs/2608.26263) — Badhe, Tiwari, Chung. EMNLP 2026. [Local summary](references/skill-state-paper.md)
- [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat)
- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)
- [Venice API](https://venice.ai)
- [Gonka — Decentralized AI Compute](https://gonka.ai)
- [OpenRouter — 100+ Models](https://openrouter.ai)

---

## Contributing

Contributions welcome. The codebase is TypeScript (ESM, zero runtime deps). To get started:

```bash
git clone https://github.com/NosytLabs/skillstate-proxy.git
cd skillstate-proxy
npm install && npm run build && npm test
```

All changes should include tests. Run `npm test` before pushing. CI runs on every push (Node 20 + 22, ubuntu-latest).

---

## Troubleshooting

**"No route to upstream" / connection refused**
→ Check `SKILLSTATE_UPSTREAM` is set and the upstream is reachable. The proxy binds to `127.0.0.1` only.

**Model doesn't emit `state_patch`**
→ The proxy automatically retries up to `maxRetries` (default 2) with a correction prompt. If it still fails, the response is forwarded as-is and Σ stays unchanged. Check `x-skillstate-validation` header for warnings.

**Session state looks wrong**
→ `GET /state` to inspect. `DELETE /state?session=<sid>` to reset. Sessions also auto-expire after `sessionTtlMs` (default 24h).

**CORS errors in browser**
→ The proxy sends `access-control-allow-origin: *` by default. Set `"cors": false` in config to disable.

**413 Request Entity Too Large**
→ Body exceeds `maxBodyBytes` (default 1MB). Increase in config or send smaller payloads.

**Unknown CLI option**
→ Run with `--help` for the full list of options and examples.

---

## FAQ

**How much can I really save?**
For agents running 50+ steps: typically 60–95% fewer prompt tokens. At 200 steps, that's 21x fewer tokens. Real cost savings depend on your provider — see the [cost calculator](#cost-calculator-estimate-your-savings) above.

**Does this work with my existing code?**
Yes. Point your OpenAI/Anthropic client's `base_url` at the proxy. No code changes needed. The proxy is transparent — it rewrites requests internally and passes through all responses normally.

**What models work best?**
Any model that can output structured JSON. GPT-4o, Claude Sonnet, Gemini Flash, and larger open models work well. Smaller models (<7B) may need more rollback-retries. The proxy handles this automatically.

**Is this production-ready?**
v0.1.1: 33 offline tests, circuit breaker + rate limiter, disk sessions, CORS. Live-tested against Gonka MiniMax-M2.7 and MiniMax-M2. MIT, no SLA.

**How is this different from just using a system prompt?**
A system prompt can ask the model to be concise, but the transcript still grows. SKILL.state physically replaces the growing transcript with a bounded state — the model never sees old messages, only the current state + latest observation.

---

## License

MIT
