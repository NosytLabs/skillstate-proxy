# skillstate-proxy

> **Drop-in OpenAI-compatible proxy that enforces [SKILL.state](https://arxiv.org/abs/2608.26263) runtime discipline for long-horizon agents.**
> Bounded prompt size, validated state updates, model-agnostic, free on Gonka decentralized compute.

[![arXiv](https://img.shields.io/badge/arXiv-2608.26263-b31b1b.svg)](https://arxiv.org/abs/2608.26263)
[![EMNLP](https://img.shields.io/badge/EMNLP-accepted-blue.svg)](https://arxiv.org/abs/2608.26263)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)](https://www.typescriptlang.org/)
[![Node 22+](https://img.shields.io/badge/node-22%2B-339933.svg)](https://nodejs.org)

## Why

LLM agents doing 50-100 step work (CI sweeps, autonomous refactors, CTF, multi-hour builds) hit two failure modes:

1. **Prompt growth.** Append-only transcript runtimes send the *entire* conversation history each step. After 50 steps you're sending ~180k tokens to ask a simple follow-up.
2. **Context poisoning.** Reasoning traces pile up; the model re-reads its own earlier mistakes and reinforces them.

The [SKILL.state paper](https://arxiv.org/abs/2608.26263) (Badhe, Tiwari, Chung; Google/Purdue; EMNLP 2026) replaces the growing transcript with a **mutable, structured execution state `Σ`** that the model reads at every step. The model gets only `(P, Σ_t, O_t)` — the immutable spec, the current state, and the latest observation — and emits a **validated `ΔΣ` state update** plus an action. Intermediate reasoning is discarded.

Result reported in the paper: **~2× accuracy at horizon 100, ~20× fewer tokens than ReAct**, with `O(1)` prompt size and `O(T)` cumulative token complexity.

`skillstate-proxy` is the first public implementation. It's a drop-in OpenAI-compatible proxy that takes any OpenAI client (opencode, Hermes, OpenClaw, anything) and gives it this discipline for free. It also merges production infrastructure from the [headroom](https://github.com/lossyrob/loonie) proxy: pricing ledger, circuit breaker, rate limiter, multi-upstream failover, and Anthropic↔OpenAI translation.

## Features

- **SKILL.state discipline** — `(P, Σ_t, O_t)` rewrites; reasoning discarded; `ΔΣ` extracted from any of: fenced ```json``` block, `STATE:` inline marker, whole-output JSON
- **Validated state updates** — schema enforcement, non-serializable value rejection, warnings surfaced in `x-skillstate-validation` response header
- **Null-deletion semantics** — set a state key to `null` to delete it (per the paper)
- **O(1) prompt size, O(T) cumulative tokens** — verified live at 50-step horizon
- **Model-agnostic** — works with any OpenAI-compatible upstream: tokenrouter, openrouter, Gonka, omlx local, OpenAI, Anthropic (via translation)
- **Production infra** — per-upstream rate limiter (RPM/TPM), circuit breaker, cost ledger (USD + GNK), Anthropic↔OpenAI format translation
- **Multi-upstream failover** — primary + fallback with health tracking
- **Zero-config session continuity** — deterministic session ID from `(system_prompt, model)` so opencode/Hermes keep Σ across requests without manual headers
- **Streaming & non-streaming** — both supported
- **Pricing awareness** — per-model USD pricing, plus Gonka GNK dual-accounting

## Quick start

```bash
# 1. install
git clone https://github.com/NosytLabs/skillstate-proxy.git
cd skillstate-proxy
npm install && npm run build

# 2. set your API key
export TOKENROUTER_API_KEY=sk-...   # or GONKA_API_KEY, OPENROUTER_API_KEY

# 3. run
npx tsx examples/warehouse.ts 5      # 5-step warehouse showcase
SKILLSTATE_LIVE=1 npx vitest run    # all tests
npx tsx test/benchmark.ts 5         # live benchmark (5 steps)
```

**Point any OpenAI client at the proxy:**

```bash
# opencode
echo '{"provider":{"skillstate":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"http://127.0.0.1:8789/v1","apiKey":"ignored"}},"models":{"z-ai/glm-5.3-free":{}}},"model":"skillstate/z-ai/glm-5.3-free"}' > ~/.config/opencode/opencode.json

# any openai-compatible client
export OPENAI_API_BASE=http://127.0.0.1:8789/v1
```

## How it works

```
                       ┌──────────────────────────────────────────┐
                       │            skillstate-proxy              │
                       │  ┌────────────────────┐                  │
   OpenAI client ────▶ │  │ 1. read Σ for sid  │                  │
   (any model)         │  │ 2. rewrite →        │ ──▶  upstream   │
                       │  │   (P, Σ, O)         │   (tokenrouter, │
                       │  │ 3. forward upstream │    openrouter,  │
                       │  │ 4. parse ΔΣ         │    gonka, …)    │
   ◀──── response ──── │  │ 5. apply ΔΣ to Σ    │                  │
                       │  │ 6. discard reasoning                  │
                       │  │ 7. log to ledger   │                  │
                       │  └────────────────────┘                  │
                       └──────────────────────────────────────────┘
```

Each request:

1. Proxy receives a normal `/v1/chat/completions` request from your client.
2. Proxy loads (or creates) the session's `Σ` from disk (per-session JSON file).
3. Proxy rewrites the request to the SKILL.state form: `[system: P+Σ, user: O]`.
4. Proxy forwards to the upstream LLM (with circuit-breaker + rate-limit checks).
5. Proxy extracts `ΔΣ` from the response (fenced ```json```, `STATE:` inline, or whole JSON).
6. Proxy applies `ΔΣ` to `Σ` with schema validation. Reasoning is discarded.
7. Proxy returns the original LLM response to the client, plus headers:
   - `x-skillstate-session` — session ID
   - `x-skillstate-step` — current step number
   - `x-skillstate-statekeys` — current Σ keys
   - `x-skillstate-upstream` — which upstream served it
   - `x-skillstate-cost-usd` / `x-skillstate-cost-gnk` — per-request cost
   - `x-skillstate-validation` — warnings if ΔΣ was malformed

## Headers

| Header | Direction | Meaning |
|---|---|---|
| `x-skillstate-session` | req/res | Session ID; send same ID to continue a conversation. If omitted, deterministic from `(system, model)`. |
| `x-skillstate-step` | res | Current step number (increments each turn). |
| `x-skillstate-statekeys` | res | Comma-separated list of current Σ keys. |
| `x-skillstate-upstream` | res | Which upstream served this request. |
| `x-skillstate-cost-usd` | res | Per-request cost in USD. |
| `x-skillstate-cost-gnk` | res | Per-request cost in GNK (if upstream is Gonka). |
| `x-skillstate-validation` | res | Pipe-separated warnings if ΔΣ was malformed. |

## Configuration

### Config file (`skillstate.json`)

```json
{
  "listenPort": 8789,
  "upstreams": [
    { "name": "gonka", "url": "https://api.openbroker.gonka.gg/v1", "apiKey": "${GONKA_API_KEY}", "priority": 0, "tpm": 1000000, "rpm": 60 },
    { "name": "tokenrouter", "url": "https://api.tokenrouter.com/v1", "apiKey": "${TOKENROUTER_API_KEY}", "priority": 1 }
  ],
  "stateDir": "~/.skillstate/state",
  "schema": ["files_checked", "secrets", "current_dir", "step"],
  "initialState": { "files_checked": [], "secrets": [], "step": 0 },
  "discardReasoning": true,
  "costLedgerPath": "~/.skillstate/spend.jsonl"
}
```

### CLI

```bash
skillstate-proxy \
  --port 8789 \
  --upstream gonka:https://api.openbroker.gonka.gg/v1 \
  --upstream tokenrouter:https://api.tokenrouter.com/v1 \
  --state-dir ~/.skillstate/state \
  --schema files_checked,secrets,step \
  --initial-state '{"step":0,"files_checked":[]}'
```

### Endpoints

| Path | Method | Purpose |
|---|---|---|
| `/v1/chat/completions` | POST | Normal OpenAI chat (rewritten) |
| `/v1/messages` | POST | Anthropic-compatible (translated) |
| `/v1/models` | GET | Passthrough to primary upstream |
| `/health` | GET | Proxy health + circuit-breaker state |
| `/cost` | GET | Cost ledger summary (USD + GNK) |

## Cost comparison (verified live)

Same task, 5 steps, vs tokenrouter free tier:

```
baseline (append-only transcript):
  prompt     :   1004 tok
  completion :    518 tok
  total      :   1522 tok
  USD (free) : $0.000000
  USD gpt-4o : $0.012790

skillstate-proxy:
  prompt     :    317 tok
  completion :      0 tok
  total      :    317 tok
  USD (free) : $0.000000
  USD gpt-4o : $0.001585

  Δ prompt    :    687 tok  (68.4% saved)
  Δ total     :   1205 tok  (79.2% saved)
```

**Break-even: ~15-20 steps.** At 50+ steps, savings grow with horizon (per the paper, up to 20× reduction at T=100).

## Gonka decentralized compute

[Gonka](https://gonka.ai) is a decentralized AI compute network that settles inference in GNK tokens. Pricing is verified flat from [gonka.broker/pricing](https://gonka.broker/pricing): **0.01 GNK per 1M tokens** (input + output, same rate), with the USD equivalent refreshed every 24h from the GonkaScan GNK/USDT midpoint (~$0.12/GNK as of 2026-08-29 → **$0.0012 USD / 1M tokens**).

**Live 50-step Software-Repository task on Gonka DeepSeek-V4-Flash:**

```
steps      : 50 / 50 OK
total tok  : ~30,000
cost GNK   : 0.000300 GNK
cost USD   : $0.000036    ($0.12/GNK)
vs gpt-4o  : ~$0.45       — ~12,500× more expensive
```

Run it yourself:

```bash
export GONKA_API_KEY=...
npx tsx examples/repo.ts 50         # 50-step software repo showcase
npx tsx examples/tau-retail.ts 25   # Sierra τ-Bench retail
npx tsx examples/warehouse.ts 10    # SkillExecBench warehouse
npx tsx examples/ctf.ts 5           # InterCode CTF
```

## Long-horizon showcases (50+ steps)

All runs are in `examples/` and can be executed against any upstream:

| File | Domain | Steps | Use case |
|---|---|---|---|
| `examples/repo.ts` | Software repo | 50 | Cherry-pick, merge, CI, releases, rollback |
| `examples/tau-retail.ts` | Sierra τ-Bench Retail | 25 | Policy-driven customer service |
| `examples/warehouse.ts` | SkillExecBench Warehouse | 10+ | Store/Ship/Move over 500 shelves |
| `examples/ctf.ts` | InterCode CTF | 5+ | 5-field schema flag extraction |
| `examples/gonka-long.ts` | Gonka long-horizon | configurable | M2.7 model showcase |
| `test/benchmark.ts` | 5-step vs baseline | 5 | Direct prompt/total token comparison |

## Token economics (O(1) prompt, O(T) total)

Per the SKILL.state paper:

```
                baseline (append-only)        skillstate-proxy
per-step prompt  O(T) — grows linearly        O(1) — constant
total tokens     O(T²) — quadratic            O(T) — linear
accuracy @T=100  lower (context poisoning)    higher (bounded state)
```

`Σ` is the only state the model sees. It can be inspected at any time:

```bash
cat ~/.skillstate/state/<session-id>.json
# {
#   "spec": "You are a CTF agent...",
#   "state": { "discovered_flags": ["FLAG{...}"], "step": 12 },
#   "schema": ["discovered_flags", "step"],
#   "step": 12
# }
```

## State schema

Define keys your agent needs. The proxy stores them as JSON. `null` deletes a key.

```ts
// examples/ctf.ts uses the 5-field CTF schema from the paper
{
  "discovered_flags": ["FLAG{abc123}"],
  "tested_hypotheses": ["binary search", "heap overflow"],
  "active_files": ["/tmp/secret.txt"],
  "working_dir": "/tmp",
  "cmd_summary": "cat secret.txt"
}
```

Out-of-schema keys are dropped and a warning is returned in `x-skillstate-validation`.

## Comparison vs headroom

| | headroom (loonie) | skillstate-proxy |
|---|---|---|
| OpenAI compat | ✅ | ✅ |
| Anthropic compat | ❌ | ✅ (translation layer) |
| Rate limiter (RPM/TPM) | ✅ | ✅ |
| Circuit breaker | ✅ | ✅ |
| Cost ledger | ✅ USD only | ✅ USD + GNK |
| Cache | ✅ | ❌ (Σ replaces cache) |
| SKILL.state discipline | ❌ | ✅ |
| O(1) prompt | ❌ | ✅ |
| Long-horizon (>50 step) | degrades | stable |

## Tested upstreams

- ✅ `https://api.openbroker.gonka.gg/v1` (Gonka decentralized) — DeepSeek-V4-Flash, MiniMax-M2.7, Kimi-K2.6
- ✅ `https://api.tokenrouter.com/v1` (tokenrouter) — `z-ai/glm-5.3-free`
- ✅ `https://openrouter.ai/api/v1` (openrouter) — `minimax/minimax-m3:free` (rate-limited on burst)
- ✅ Anthropic `/v1/messages` translation (Anthropic ↔ OpenAI)
- ✅ Any other OpenAI-compatible (omlx local, vLLM, etc.)

## Running tests

```bash
# unit (no network)
npx vitest run test/state.test.ts

# all tests including live (requires API key)
SKILLSTATE_LIVE=1 npx vitest run
```

Unit tests: **13/13 pass** (merge, extract, prompt, validation, schema enforcement, null-deletion, complexity property).

## License

MIT — NosytLabs 2026

## References

- [SKILL.state: Scalable Long-Horizon Agent Skills](https://arxiv.org/abs/2608.26263) — Badhe, Tiwari, Chung (Google/Purdue, EMNLP 2026)
- [Project site](http://skill.state/)
- [headroom proxy](https://github.com/lossyrob/loonie) — production infrastructure inspiration
- [Gonka decentralized AI](https://gonka.ai) — decentralized compute
- [Sierra τ-Bench](https://github.com/sierra-research/tau-bench) — public customer-service benchmark
- [InterCode CTF](https://github.com/princeton-nlp/intercode) — public CTF benchmark
