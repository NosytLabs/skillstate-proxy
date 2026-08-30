# skillstate-proxy

> **OpenAI-compatible proxy that enforces [SKILL.state](https://arxiv.org/abs/2608.26263) (Badhe, Tiwari, Chung — EMNLP 2026). Bounded O(1) prompts, O(T) total tokens vs O(T²) for append-only transcripts. Drop-in front of any OpenAI-compatible upstream.**

[![paper](https://img.shields.io/badge/arXiv-2608.26263-b31b1b.svg)](https://arxiv.org/abs/2608.26263)
[![EMNLP 2026](https://img.shields.io/badge/EMNLP-2026-2c7be5.svg)](https://arxiv.org/abs/2608.26263)
[![MIT](https://img.shields.io/badge/license-MIT-green.svg)](#license)

```
client ──► skillstate-proxy ──► upstream (Venice / OpenAI / OpenRouter / Anthropic / vLLM / ...)
              │
              ├─ maintains Σ per conversation (JSON state file on disk)
              ├─ rewrites every request to (P, Σ, O) — spec, state, latest observation only
              ├─ parses model response for ΔΣ (state_patch) + action, applies Σ ← Σ ⊕ ΔΣ
              └─ discards reasoning after the validated update
```

---

## Explain like I'm 10

Imagine your AI is playing a video game and needs to remember where they are, what items they picked up, and what the bad guy is doing. Most AIs work like this: **they write down EVERYTHING** — every step, every thought — and read the whole notebook each time they need to decide what to do next. By level 100, the notebook is HUGE. They get slow, confused, and forget what's true.

**SKILL.state works differently.** Instead of a giant notebook, the AI keeps a **little whiteboard** with just the important facts. Each turn, the AI writes only what *changed* (`add "sword"`, `delete "old key"`) and then we **throw away all the chatter and thinking**. Next turn, the AI sees the tiny whiteboard + just the *latest* thing that happened.

**Why is this great?**
- 🧠 **The AI stays focused.** No old, wrong, or noisy stuff tricking it.
- 💸 **You pay way less.** Each turn is a *small, fixed size* instead of "every turn I pay for all previous turns."
- 🛠️ **Works for any AI.** Same trick, any model, any task.
- 🔄 **Recovers instantly.** If the world changes behind its back, the AI updates the whiteboard right away.

**The downside?** You have to write down *which facts matter* ahead of time (a tiny "schema"), and the AI has to learn to reply in a specific shape (a JSON block). If a really tiny AI can't follow the shape, the proxy gently asks it to try again.

---

## Pros and cons

### ✅ Pros
- **Massive token savings on long-horizon tasks.** The paper shows ~**19–21× fewer tokens** than a plain ReAct loop at T=100–200, while being **more accurate** (not less). Even at short horizons (T=10) it's already cheaper, and the gap widens with every step.
- **Lower cost on any model.** Because prompts stay bounded, the dollar bill drops — whether you're paying OpenAI, Anthropic, or running local.
- **Robust to noise and stale context.** SKILL.state holds ≥0.97 accuracy at 5/20/50 distractor events/turn; ReAct-style drops from 0.68 → 0.53.
- **Instant state recovery.** When the environment changes behind the agent's back, baseline runtimes hallucinate for 5–12 turns; SKILL.state recovers in **0** steps.
- **Drop-in.** Any OpenAI-compatible client works — opencode, Hermes, raw `curl`, the OpenAI Python SDK, etc.
- **Streaming, multi-upstream failover, cost ledger, circuit breaker** built in.

### ⚠️ Cons / trade-offs
- **You author a domain schema.** Schemas are *per domain*, written once. If you don't know which keys matter yet, start with a permissive `{}` and tighten later.
- **Small models can struggle with structured output.** Paper §5.7: open-weight models show *premature overwrite* (68%), *schema confusion* (20%), *JSON syntax slips* (12%). The proxy mitigates this with **rollback-retry** and **schema enforcement**.
- **One extra network hop.** Adds tiny per-call latency. Negligible vs LLM time.
- **No built-in tool-calling plumbing.** The proxy enforces the *runtime* (Σ), not tool execution. Your agent code still handles `action` execution.

---

## How it works

```
At each step t:
  1. build  (P, Σₜ, Oₜ)        — immutable spec + structured state + latest observation
  2. prompt the model
  3. model emits  (Rₜ, ΔΣₜ, aₜ) — reasoning (discarded) + state_patch + action
  4. validate ΔΣₜ               — JSON shape, schema membership, type serializability
       ├─ valid    → Σₜ₊₁ ← Σₜ ⊕ ΔΣₜ     (null deletes a key)
       └─ invalid  → rollback-retry       (re-prompt with a corrective note)
  5. execute aₜ
  6. Rₜ is discarded permanently
```

The model's expected reply shape:

```jsonc
// ```json fenced block — exactly these two top-level keys:
{
  "state_patch": { "step": 3, "flag": "found", "old_key": null },  // null deletes
  "action":      "ls -la"
}
```

---

## Quickstart

```bash
# 1. install
git clone https://github.com/NosytLabs/skillstate-proxy.git
cd skillstate-proxy
npm install && npm run build

# 2. start (point at any OpenAI-compatible endpoint)
SKILLSTATE_UPSTREAM=https://api.venice.ai/api/v1 \
SKILLSTATE_API_KEY=your-venice-key \
SKILLSTATE_MODEL=qwen3-5-9b \
SKILLSTATE_SCHEMA=step,notes,flags \
SKILLSTATE_INITIAL_STATE='{"step":0,"notes":[],"flags":[]}' \
npm start

# 3. call it — same shape as any OpenAI client
curl http://127.0.0.1:8789/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3-5-9b","messages":[
        {"role":"system","content":"TASK: track discoveries in state"},
        {"role":"user","content":"I found a secret door"}]}'
```

You get back a normal `chat.completion` **plus** SKILL.state headers:

```
x-skillstate-session:   <session-id>
x-skillstate-step:      1
x-skillstate-statekeys: step,notes,flags
x-skillstate-action:    <the model's action string>
x-skillstate-cost-usd:  0.000023
x-skillstate-retries:   0
```

Send `x-skillstate-session: <id>` on the next call to continue that conversation. Or omit it and the proxy derives a session from `(system-prompt, model)` — useful for zero-config clients.

---

## Setup

### Environment variables (quickest)

```bash
SKILLSTATE_UPSTREAM=https://api.venice.ai/api/v1 \
SKILLSTATE_API_KEY=your-key \
SKILLSTATE_MODEL=qwen3-5-9b \
SKILLSTATE_SCHEMA=step,notes,flags \
SKILLSTATE_INITIAL_STATE='{"step":0,"notes":[],"flags":[]}' \
npx skillstate
```

### Config file (`skillstate.json`)

```json
{
  "listenPort": 8789,
  "upstreams": [
    { "name": "venice", "url": "https://api.venice.ai/api/v1", "apiKey": "${VENICE_INFERENCE_KEY}", "priority": 0 },
    { "name": "openai", "url": "https://api.openai.com/v1",    "apiKey": "${OPENAI_API_KEY}",       "priority": 1 }
  ],
  "stateDir":        "~/.skillstate/state",
  "schema":          ["step","notes","flags"],
  "initialState":    { "step": 0, "notes": [], "flags": [] },
  "discardReasoning": true,
  "costLedgerPath":  "~/.skillstate/spend.jsonl",
  "maxRetries":      2
}
```

### Environment variables

| Var | Purpose |
|---|---|
| `SKILLSTATE_PORT`            | listen port (default `8789`) |
| `SKILLSTATE_UPSTREAM`        | upstream URL |
| `SKILLSTATE_API_KEY`         | API key for the upstream |
| `SKILLSTATE_MODEL`           | default model id |
| `SKILLSTATE_SCHEMA`          | comma-separated schema keys |
| `SKILLSTATE_INITIAL_STATE`   | JSON string of initial Σ |
| `SKILLSTATE_CONFIG`          | path to a JSON config file |
| `SKILLSTATE_LIVE`            | set `1` to enable live integration tests |

---

## Wire any client

### opencode (`opencode.json`)

```json
{
  "provider": {
    "skillstate": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:8789/v1",
        "apiKey":  "anything-the-proxy-forwards-your-real-key"
      },
      "models": { "qwen3-5-9b": {} }
    }
  },
  "model": "skillstate/qwen3-5-9b"
}
```

### OpenAI Python SDK (just point `base_url`)

```python
from openai import OpenAI
c = OpenAI(base_url="http://127.0.0.1:8789/v1", api_key="ignored")
r = c.chat.completions.create(model="qwen3-5-9b",
    messages=[{"role":"system","content":"TASK: track state"},
              {"role":"user","content":"go"}])
print(r.choices[0].message.content, dict(r._http_response.headers))
```

### Anthropic clients

The proxy auto-translates `/v1/messages` to OpenAI for the upstream and translates the response back. Set `base_url` to `http://127.0.0.1:8789`.

---

## Token economics (from the paper)

Baseline = plain ReAct (append full transcript). SkillExecBench Warehouse, Gemini-3-Flash:

| Horizon T | Baseline tokens | SKILL.state tokens | Reduction | Baseline accuracy | SKILL.state accuracy |
|-----------|----------------:|-------------------:|----------:|------------------:|---------------------:|
| 10        | ~9.4 k          | ~5.9 k             | **~1.6×** | 0.90              | **1.00**             |
| 50        | ~250 k          | ~33 k              | **~7.6×** | 0.79              | **0.96**             |
| 100       | 1,245,413       | 65,408             | **~19×**  | 0.84              | **0.94**             |
| 200       | 2,608,755       | 122,384            | **~21×**  | 0.74              | **0.94**             |

Other benchmarks:

| Benchmark | Baseline tokens | SKILL.state tokens | Reduction | Baseline best | SKILL.state |
|-----------|----------------:|-------------------:|----------:|--------------:|------------:|
| InterCode CTF | 977 k | 387 k | **~2.5×** | 46.4% | **54.2%** |
| Sierra τ-Bench Retail | — | — | ~40% | 51.7% | **58.3%** |

**Budget-matched control (T=100, all runtimes capped at ~1800 tok/step):**

| Runtime | T=100 score |
|---------|------------:|
| Truncated (sliding window) | 0.18 |
| Summary-capped | 0.52 |
| ReAct + LLMLingua | 0.22 |
| **SKILL.state** | **0.94** |

Even with the *same* token budget, compressing/clipping history catastrophically breaks accuracy. The structure of Σ is what matters.

**Noise robustness (T=50):**

| Distractors/turn | Baseline | SKILL.state |
|------------------|---------:|------------:|
| 5                | 0.68     | **1.00**    |
| 20               | 0.61     | **0.97**    |
| 50               | 0.53     | **0.98**    |

**State recovery:** when the environment changes behind the agent's back, baselines hallucinate for 5–12 turns; SKILL.state recovers in **0** steps.

### Real Venice benchmark (verified)

50-step code review scenario on Venice's qwen3-5-9b ($0.10/$0.15 per 1M tokens):

| Metric | Baseline | SKILL.state | Savings |
|--------|----------|-------------|---------|
| Prompt tokens (50 steps) | 210,853 | 78,004 | **63.0%** |
| Actual Venice cost | $0.0225 | $0.0097 | **$0.013 saved** |
| Tokens at step 50 | 7,131 | 1,606 | **4.4× less** |
| Projected at 200 steps | ~843k tokens | ~1,560/step (constant) | **~540× less cumulative** |

Per-step prompt token growth (qwen3-5-9b, 50 steps):

| Step | Baseline | SKILL.state | Ratio |
|-----:|---------:|------------:|------:|
| 1    | 1,240    | 1,474       | 0.8×  |
| 5    | 1,591    | 1,492       | 1.1×  |
| 10   | 2,190    | 1,581       | 1.4×  |
| 20   | 3,541    | 1,528       | 2.3×  |
| 30   | 4,827    | 1,541       | 3.1×  |
| 50   | 7,131    | 1,606       | **4.4×** |

Projected at 200 steps on GPT-4o pricing ($2.50/$10.00 per 1M): **$0.62 vs $0.32** — a **48% cost reduction**.

Run it yourself:
```bash
SKILLSTATE_API_KEY=<your-venice-key> npx tsx test/benchmark-venice.ts 50
```

---

## Tests

```bash
# unit tests (no network, fully deterministic)
npm test

# live integration test (needs API key)
SKILLSTATE_LIVE=1 \
SKILLSTATE_API_KEY=your-venice-key \
SKILLSTATE_UPSTREAM=https://api.venice.ai/api/v1 \
SKILLSTATE_MODEL=qwen3-5-9b \
  npm test -- test/live.test.ts

# quick baseline-vs-SKILL.state benchmark
SKILLSTATE_API_KEY=your-venice-key \
SKILLSTATE_MODEL=qwen3-5-9b \
  npx tsx test/benchmark.ts 10

# 50-step Venice real-cost benchmark
SKILLSTATE_API_KEY=your-venice-key \
npx tsx test/benchmark-venice.ts 50
```

---

## Project layout

```
src/
  state.ts          SKILL.state core (Σ, merge, extract, apply, prompt)
  proxy.ts          HTTP proxy: rewrite → upstream → extract ΔΣ → merge Σ → respond
  anthropic.ts      Anthropic ↔ OpenAI wire translator
  cost-ledger.ts    JSONL spend ledger
  circuit-breaker.ts, rate-limiter.ts, token-estimate.ts
  pricing.ts        USD/GNK per-1M-token table
  cli.ts, index.ts
test/
  state.test.ts     merge / extract / prompt / apply (18 tests)
  proxy.test.ts     end-to-end with in-process mock upstream (4 tests)
  live.test.ts      live 3-step loop (requires API key)
  anthropic.test.ts Anthropic translation test (requires API key)
  benchmark.ts      baseline-vs-SKILL.state quick benchmark
  benchmark-venice.ts  50-step Venice real-cost benchmark
references/
  skill-state-paper.md  paper summary with links
```

---

## References

- [**SKILL.state: Scalable Long-Horizon Agent Skills**](https://arxiv.org/abs/2608.26263) — Badhe, Tiwari, Chung. EMNLP 2026. [Local summary →](references/skill-state-paper.md)
- [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat)
- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)

---

## License

MIT © NosytLabs 2026
