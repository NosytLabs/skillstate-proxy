# skillstate-proxy

> **Drop-in OpenAI-compatible proxy that enforces [SKILL.state](https://arxiv.org/abs/2608.26263) (EMNLP 2026) — keeps agent prompts bounded at O(1) per step, saving 60%+ tokens on long-horizon tasks.**

[![arXiv](https://img.shields.io/badge/arXiv-2608.26263-b31b1b.svg)](https://arxiv.org/abs/2608.26263)
[![EMNLP 2026](https://img.shields.io/badge/EMNLP-2026-2c7be5.svg)](https://arxiv.org/abs/2608.26263)
[![MIT](https://img.shields.io/badge/license-MIT-green.svg)](#license)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

```
client ──► skillstate-proxy ──► any upstream (OpenAI / Anthropic / Venice / OpenRouter / vLLM / ...)
              │
              ├─ maintains structured state Σ per conversation (JSON on disk)
              ├─ rewrites every request to (P, Σ, O) — spec + state + latest observation
              ├─ parses model output for state_patch ΔΣ + action, merges Σ ← Σ ⊕ ΔΣ
              └─ discards reasoning after validated update (never re-sent)
```

---

## Explain like I'm 10

Most AIs work by writing down **everything** that ever happened — every step, every thought — and reading the whole notebook each time. By step 100, the notebook is huge. The AI gets slow, confused, and expensive.

**SKILL.state uses a whiteboard instead.** The AI keeps only the important facts on a small whiteboard. Each turn it writes what *changed* (`add "sword"`, `delete "old key"`), then we **throw away all the thinking**. Next turn, the AI sees just the whiteboard + the latest thing that happened.

**Results:** 60%+ fewer tokens, lower costs, and the AI stays more accurate because it's not distracted by stale noise.

**Trade-off:** You define a tiny schema of which facts matter (one time), and the AI replies in a structured JSON shape. If a small model struggles with the format, the proxy retries automatically.

---

## Why use it

| | Without SKILL.state | With SKILL.state |
|---|---|---|
| **Prompt at step 50** | ~7,000 tokens (growing) | ~1,500 tokens (constant) |
| **Total tokens (50 steps)** | ~210k | ~78k (**63% less**) |
| **Accuracy at T=200** | 0.74 | **0.94** |
| **State recovery** | 5-12 turns hallucinating | **0 steps** |
| **Noise robustness** | Degrades to 0.53 | Stays **0.98** |

Verified on Venice API with real cost reporting (qwen3-5-9b, 50 steps).

---

## Quickstart

```bash
# install
git clone https://github.com/NosytLabs/skillstate-proxy.git
cd skillstate-proxy
npm install && npm run build

# start — point at any OpenAI-compatible endpoint
SKILLSTATE_UPSTREAM=https://api.openai.com/v1 \
SKILLSTATE_API_KEY=your-key \
npm start

# call it — works like any OpenAI client
curl http://127.0.0.1:8789/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"system","content":"TASK: track state"},{"role":"user","content":"go"}]}'
```

Responses include SKILL.state headers (`x-skillstate-session`, `x-skillstate-step`, `x-skillstate-cost-usd`). Send the session header back to continue a conversation.

---

## Setup

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SKILLSTATE_UPSTREAM` | `https://api.openai.com/v1` | Upstream API URL |
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
  "maxRetries": 2
}
```

Multi-upstream failover is built in — requests route by priority, with circuit breaker + rate limiter per upstream.

---

## Wire any client

Any OpenAI-compatible client works. Just point `base_url` at the proxy.

### Python

```python
from openai import OpenAI
c = OpenAI(base_url="http://127.0.0.1:8789/v1", api_key="ignored")
r = c.chat.completions.create(model="gpt-4o",
    messages=[{"role":"system","content":"TASK: track state"},
              {"role":"user","content":"go"}])
```

### curl

```bash
curl http://127.0.0.1:8789/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"system","content":"TASK: track state"},{"role":"user","content":"go"}]}'
```

### Anthropic clients

The proxy auto-translates `/v1/messages` to OpenAI format and translates the response back. Set `base_url` to `http://127.0.0.1:8789`.

---

## How it works

```
Each step t:
  1. Build prompt: (P, Σₜ, Oₜ) — spec + state + latest observation only
  2. Send to model
  3. Model emits: reasoning + state_patch (ΔΣₜ) + action
  4. Validate ΔΣₜ — JSON shape, schema membership, type serializability
       ├─ valid   → merge: Σₜ₊₁ ← Σₜ ⊕ ΔΣₜ  (null deletes a key)
       └─ invalid → rollback-retry (re-prompt with correction)
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

---

## Benchmarks

### Paper results (SkillExecBench Warehouse, Gemini-3-Flash)

| Steps | Baseline tokens | SKILL.state tokens | Reduction | Accuracy (baseline → SKILL.state) |
|------:|----------------:|-------------------:|----------:|-----------------------------------:|
| 10 | 9.4k | 5.9k | 1.6x | 0.90 → **1.00** |
| 50 | 250k | 33k | 7.6x | 0.79 → **0.96** |
| 100 | 1,245,413 | 65,408 | **19x** | 0.84 → **0.94** |
| 200 | 2,608,755 | 122,384 | **21x** | 0.74 → **0.94** |

### Real Venice API benchmark (qwen3-5-9b, 50 steps)

| | Baseline | SKILL.state | Savings |
|---|---:|---:|---:|
| Prompt tokens | 210,853 | 78,004 | **63%** |
| Actual cost | $0.0225 | $0.0097 | $0.013 |
| Tokens at step 50 | 7,131 | 1,606 | **4.4x less** |

Run it yourself:
```bash
SKILLSTATE_API_KEY=your-key npx tsx test/benchmark-venice.ts 50
```

---

## Tests

```bash
npm test                          # 22 unit tests (no network)
SKILLSTATE_LIVE=1 npm test        # + live integration tests (needs API key)
```

---

## Project layout

```
src/
  state.ts            SKILL.state core (merge, extract, apply, prompt)
  proxy.ts            HTTP proxy: rewrite → upstream → extract ΔΣ → merge Σ → respond
  anthropic.ts        Anthropic ↔ OpenAI wire translator
  pricing.ts          USD pricing table (OpenAI, Anthropic, Venice, Gonka, local)
  cost-ledger.ts      JSONL spend ledger
  circuit-breaker.ts  Per-upstream circuit breaker
  rate-limiter.ts     Per-upstream rate limiter
  token-estimate.ts   Token count estimator
  cli.ts              CLI entry point
  index.ts            Public API
test/
  state.test.ts       18 unit tests
  proxy.test.ts       4 integration tests (in-process mock upstream)
  live.test.ts        Live 3-step loop (requires API key)
  benchmark.ts        Quick baseline vs SKILL.state benchmark
  benchmark-venice.ts 50-step Venice real-cost benchmark
references/
  skill-state-paper.md  Paper summary with implementation checklist
```

---

## References

- [**SKILL.state: Scalable Long-Horizon Agent Skills**](https://arxiv.org/abs/2608.26263) — Badhe, Tiwari, Chung. EMNLP 2026. [Local summary](references/skill-state-paper.md)
- [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat)
- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)

---

## License

MIT
