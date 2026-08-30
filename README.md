# skillstate-proxy

> **Drop-in token-savings proxy for long-horizon LLM agents. Cuts prompt tokens 60-95% and keeps accuracy high. Works with any OpenAI- or Anthropic-compatible API. Implements [SKILL.state](https://arxiv.org/abs/2608.26263) (EMNLP 2026).**

[![arXiv](https://img.shields.io/badge/arXiv-2608.26263-b31b1b.svg)](https://arxiv.org/abs/2608.26263)
[![EMNLP 2026](https://img.shields.io/badge/EMNLP-2026-2c7be5.svg)](https://arxiv.org/abs/2608.26263)
[![Tests](https://img.shields.io/badge/tests-25%2F25%20passing-brightgreen.svg)](#tests)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](#license)

```
client ──► skillstate-proxy ──► any upstream (OpenAI · Anthropic · Venice · OpenRouter · vLLM · Ollama · ...)
               │
               ├─ keeps a small structured state Σ per session (JSON, on disk)
               ├─ rewrites every request to (P, Σ, O) — spec + state + latest observation
               ├─ extracts state_patch ΔΣ + action from each model reply, merges Σ ← Σ ⊕ ΔΣ
               └─ discards reasoning after validated update — never re-sent
```

---

## What is this?

A local HTTP proxy that sits between your LLM agent and any OpenAI-compatible API. It automatically:

1. **Replaces growing conversation history** with a small, fixed-size structured state
2. **Cuts prompt tokens 60-95%** on long-horizon tasks (50+ steps) — real money saved on per-token APIs
3. **Improves accuracy** by removing stale, noisy context (0.94 vs 0.74 at 200 steps)
4. **Works with any model** — OpenAI, Anthropic, Venice, OpenRouter, vLLM, Ollama, and any OpenAI-compatible endpoint

If your agent runs longer than ~15 steps, this saves you money and keeps it accurate.

---

## Explain like I'm 10

Most AIs work by writing down **everything** that ever happened — every step, every thought — and reading the whole notebook each time they act. By step 100, the notebook is huge. The AI gets slow, confused, and expensive.

**SKILL.state uses a whiteboard instead.** The AI keeps only the important facts on a small whiteboard. Each turn it writes what *changed* (`add "sword"`, `delete "old key"`), and then we **throw away all the thinking**. Next turn, the AI sees just the whiteboard + the newest thing that happened.

**Benefits:** 60-95% fewer tokens → lower bills, faster responses, and the AI stays accurate because it isn't distracted by stale notes.

**Cons / trade-offs:** You define a tiny schema of which facts matter (once, per domain), and the model must reply in a structured JSON shape. Small models sometimes struggle with the format — the proxy retries them automatically (rollback-retry).

**Who it's for:** Anyone running LLM agents for 15+ steps — coding assistants, research agents, task planners, support bots, autonomous workflows. The longer the task, the bigger the savings.

---

## Real benchmark (Venice API · qwen3-5-9b · 50 steps)

Actual measured runs through this proxy vs. a plain append-only transcript. Costs are Venice's real reported per-request USD (run 2026-08-30).

| | Baseline | SKILL.state | Savings |
|---|---:|---:|---:|
| Prompt tokens (50 steps) | 274,540 | 75,606 | **72.5% less** |
| Real cost | $0.0292 | $0.0097 | $0.0195 (67%) |
| Tokens at step 50 | 9,746 | 1,606 | **6.1x less** |
| Tokens at step 20 | 4,636 | 1,439 | 3.2x less |

The baseline prompt grows linearly every step; SKILL.state stays ~1,500 tokens/step **no matter how long the task runs**. At 200+ steps the gap is 20x or more (see [paper results](#paper-benchmarks)).

At GPT-4o rates the same 50-step workload would cost **$0.81 baseline vs $0.33 with SKILL.state**.

Run it yourself on any provider:

```bash
SKILLSTATE_API_KEY=your-key npx tsx test/benchmark.ts 50
```

---

## Why use it

| | Without SKILL.state | With SKILL.state |
|---|---|---|
| **Prompt at step 50** | ~9,700 tokens (growing) | ~1,500 tokens (constant) |
| **Total tokens (50 steps)** | ~275k | ~76k (**72% less**) |
| **Accuracy at T=200** | 0.74 | **0.94** |
| **State recovery after environment drift** | 5-8 turns hallucinating | **0 steps** (Σ on disk) |
| **Noise robustness (50 distractors/turn)** | Degrades to 0.53 | Stays **0.98** |

The longer your agent runs, the more you save. At 500 steps: ~750k tokens vs ~13M baseline — a **17x reduction**.

---

## Use cases

- **Long-horizon autonomous agents** — coding assistants, research agents, and planners running 50-200+ steps. The longer the task, the bigger the savings.
- **Customer support & conversational agents** — maintain a compact case file instead of replaying the whole chat every turn.
- **Cost-sensitive deployments** — pay per token on OpenAI/Anthropic/Venice? Cutting prompt tokens 60-95% cuts the bill directly.
- **Multi-agent systems** — each agent gets its own bounded state, preventing cross-agent context pollution.
- **Local models (vLLM, Ollama, llama.cpp)** — smaller prompts mean faster inference, less VRAM, longer tasks on the same hardware.
- **Decentralized compute (Gonka)** — run agents on [gonka.ai](https://gonka.ai)'s decentralized GPU network; its already-low pricing compounds with SKILL.state's token cuts.

---

## Quickstart

```bash
# option A — install globally
npm install -g skillstate-proxy

# option B — clone + build from source
git clone https://github.com/NosytLabs/skillstate-proxy.git
cd skillstate-proxy
npm install && npm run build

# start — point at any OpenAI-compatible endpoint
SKILLSTATE_UPSTREAM=https://api.openai.com/v1 \
SKILLSTATE_API_KEY=your-key \
skillstate            # or: npm start

# call it — works like any OpenAI client
curl http://127.0.0.1:8789/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"system","content":"TASK: track state"},{"role":"user","content":"go"}]}'
```

Responses include SKILL.state headers (`x-skillstate-session`, `x-skillstate-step`, `x-skillstate-cost-usd`). Send the session header back to continue a conversation. Without the header, the proxy derives a deterministic session from (system prompt + model), so even zero-config clients get state continuity.

### Inspect & manage state

```bash
curl http://127.0.0.1:8789/state                          # list sessions
curl http://127.0.0.1:8789/state?session=<sid>            # view Σ for one session
curl -X DELETE http://127.0.0.1:8789/state?session=<sid>  # reset a session
curl http://127.0.0.1:8789/cost                           # 24h spend summary
curl http://127.0.0.1:8789/health                         # upstream circuit status
```

---

## Setup

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SKILLSTATE_UPSTREAM` | `https://api.openai.com/v1` | Upstream API base URL |
| `SKILLSTATE_API_KEY` | — | API key for the upstream |
| `SKILLSTATE_PORT` | `8789` | Listen port |
| `SKILLSTATE_SCHEMA` | — | Comma-separated state keys (e.g. `step,notes,flags`) |
| `SKILLSTATE_INITIAL_STATE` | `{}` | JSON string of initial state |
| `SKILLSTATE_CONFIG` | — | Path to a JSON config file |

### Config file (`skillstate.json`)

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
  "circuitBreaker": { "failureThreshold":  5, "openCooldownMs": 30000 }
}
```

Multi-upstream failover is built in — requests route by priority with a circuit breaker + rate limiter per upstream.

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

### curl

```bash
curl http://127.0.0.1:8789/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"system","content":"TASK: track state"},{"role":"user","content":"go"}]}'
```

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

The paper is explicit about where the approach loses:

- **No fixed schema in advance** — if the state structure must be discovered during execution, structured state is weaker than a transcript.
- **Deferred-relevance observations** — if a step depends on something observed earlier whose importance wasn't recognized at the time (and thus never committed to Σ), it's gone.
- **Trajectory-defined objectives** — auditing, provenance, "explain what you did" tasks where the history *is* the output.
- **Small models + JSON** — weak models fail on output format, not reasoning (68% of failures are overwrite-instead-of-merge, 20% type confusion, 12% syntax). The proxy's rollback-retry and schema enforcement mitigate this, but constrained decoding is the paper's recommended fix.

Single-agent only — multi-agent would need deterministic conflict resolution in the merge operator for concurrent writes.

---

## Supported providers

| Provider | Examples | Pricing (input) |
|---|---|---|
| **OpenAI** | gpt-4o, gpt-5.4 | $2.50-$5/1M |
| **Anthropic** | claude-sonnet-4.5, claude-opus-4.5 | $3-$15/1M |
| **Venice** | qwen3-5-9b, kimi-k3, llama variants | $0.10-$0.30/1M |
| **OpenRouter** | 100+ models | varies |
| **Local** | vLLM, Ollama, llama.cpp | free |

Works with **any** OpenAI-compatible endpoint — just set `SKILLSTATE_UPSTREAM`. No code changes in your client.

### Gonka — decentralized AI compute

[Gonka](https://gonka.ai) is a decentralized GPU network: instead of one company's datacenter, inference runs on a global network of hosts, settled in GNK token (~$0.12). That already makes per-token pricing extremely low (~0.01 GNK per 1M tokens — a few cents per *million* tokens). Pair it with SKILL.state and the two savings compound: Gonka cuts the price per token, SKILL.state cuts the *number* of tokens. Set `SKILLSTATE_UPSTREAM` to your Gonka gateway endpoint and optionally `"currency": "gnk"` per upstream in the config to track spend in GNK alongside USD.

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
  cli.ts              CLI entry point (graceful shutdown)
  index.ts            Public API barrel
test/
  state.test.ts       18 unit tests (merge, extraction, validation, prompt)
  proxy.test.ts       5 integration tests (in-process mock upstream)
  live.test.ts        Live 3-step loop (SKILLSTATE_LIVE=1 + key)
  anthropic.test.ts   Live /v1/messages translation (SKILLSTATE_LIVE=1 + key)
  benchmark.ts        SKILL.state vs baseline benchmark (any provider)
references/
  skill-state-paper.md  Paper summary with implementation checklist
```

---

## Tests

```bash
npm test                              # 23 offline tests (no network)
SKILLSTATE_LIVE=1 SKILLSTATE_API_KEY=... npm test   # + live provider tests (25 total)
```

Offline tests need no API key. Live tests run only with `SKILLSTATE_LIVE=1` and a real key — verified against Venice (qwen3-5-9b).

---

## References

- [**SKILL.state: Scalable Long-Horizon Agent Skills**](https://arxiv.org/abs/2608.26263) — Badhe, Tiwari, Chung. EMNLP 2026. [Local summary](references/skill-state-paper.md)
- [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat)
- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)
- [Venice API](https://venice.ai)

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

---

## License

MIT
