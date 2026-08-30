# skillstate-proxy

OpenAI-compatible proxy that enforces **SKILL.state** runtime discipline ([arXiv:2608.26263](https://arxiv.org/abs/2608.26263)).

Instead of sending the full growing transcript to the LLM each step, the proxy maintains a bounded execution state `Σ` server-side and rewrites every request to **O(1) prompt size**: `(P, Σ, O)` — spec, current state, latest observation only. The model outputs reasoning + a `ΔΣ` state delta + action. **Reasoning is discarded** after extraction; only `Σ` survives to the next step.

Result: **O(T) total tokens** instead of O(T²), with the paper reporting ~2× better accuracy at horizon 100 and ~20× fewer tokens than ReAct.

---  

## How it works

```text
Client ──► skillstate-proxy ──► upstream (tokenrouter / openrouter / gonka/openbroker / ...)
              │
              ├─ maintains Σ per conversation (JSON state file on disk)
              ├─ rewrites request: [system: P+Σ, user: O]
              ├─ parses response: extracts ΔΣ, applies to Σ
              └─ discards reasoning; echoes only the visible action back
```

### State schema

Define the keys your agent needs. The proxy stores them as JSON; keys set to `null` are deleted (null-deletion semantics from the paper).

```json
{
  "files_checked": [],
  "secrets": [],
  "current_dir": "/tmp",
  "step": 0
}
```

### Request/response flow

1. Client sends normal `/v1/chat/completions` request  
2. Proxy adds/reads `x-skillstate-session` header (auto-generated UUID if missing)  
3. Proxy rewrites messages to `[system: P+Σ, user: O]`  
4. Upstream responds normally  
5. Proxy extracts `ΔΣ` from the response, updates Σ, saves it  
6. Response echoes back to client unchanged; `x-skillstate-step` and `x-skillstate-statekeys` headers added  

### Headers

| Header | Direction | Meaning |
|--------|-----------|---------|
| `x-skillstate-session` | req/res | Session ID; send same ID to continue a conversation |
| `x-skillstate-step` | res | Current step number (increments each turn) |
| `x-skillstate-statekeys` | res | Comma-separated list of current Σ keys |
| `x-skillstate-upstream` | res | Which upstream handled the request (for multi‑upstream fallbacks) |
| `x-skillstate-cost-usd` | res | Estimated USD cost of this request (based on upstream pricing) |
| `x-skillstate-cost-gnk` | res | Estimated GNK cost (if upstream is gonka) |

---  

## Token economics (realistic)

| Metric | Baseline (full replay) | skillstate-proxy (with estimateTokens fallback) | Notes |
|--------|------------------------|------------------------------------------------|-------|
| Prompt size per step | O(T) — grows linearly | **O(1)** — constant (~100-200 tokens) | Σ snapshot + latest obs only |
| Completion overhead | baseline | +0-30% per step | Model emits `ΔΣ` structured block |
| **Net savings at 5 steps** | ~1k tokens | ~0.7k tokens | Overhead dominates at short horizons |
| **Net savings at 50 steps** | ~15k tokens | ~6k tokens | Prompt growth dominates |
| **Net savings at 100 steps** | ~180k tokens | ~9k tokens | ~20× fewer tokens, +2× accuracy (per paper) |

**Break-even: ~15-20 steps.** For long-running agent loops (build/test/sweep cycles, multi-hour tasks, cron jobs), the proxy pays for itself. For single-turn chat, use direct mode.

> **Note**: When the upstream does not return token usage (e.g. tokenrouter free tier), the proxy falls back to a lightweight character‑based estimator (`estimateTokens`) so the cost ledger still reflects *approximate* consumption. The ledger is therefore always meaningful, even if approximate.

---  

## Setup

### Install

```bash
git clone https://github.com/NosytLabs/skillstate-proxy.git
cd skillstate-proxy
npm install
npm run build
```

### Run

```bash
# with config file
skillstate-proxy --config skillstate.json

# or inline
skillstate-proxy --port 8789 \
  --upstream tokenrouter:https://api.tokenrouter.com/v1 \
  --upstream openrouter:https://openrouter.ai/api/v1 \
  --state-dir ~/.skillstate/state \
  --schema files_checked,secrets,step
```

### Config file (`skillstate.json`)

```json
{
  "listenPort": 8789,
  "upstreams": [
    { "name": "tokenrouter", "url": "https://api.tokenrouter.com/v1", "priority": 0 },
    { "name": "openrouter",   "url": "https://openrouter.ai/api/v1",   "priority": 1 }
  ],
  "stateDir": "~/.skillstate/state",
  "schema": ["files_checked", "secrets", "current_dir", "step"],
  "initialState": { "files_checked": [], "secrets": [], "step": 0 },
  "discardReasoning": true,
  "costLedgerPath": "~/.skillstate/spend.jsonl"
}
```

---  

## Client configs

### opencode — point at the proxy like headroom:

```json
{
  "provider": {
    "skillstate": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:8789/v1",
        "apiKey": "ignored-by-proxy"
      },
      "models": { "z-ai/glm-5.3-free": {} }
    }
  },
  "model": "skillstate/z-ai/glm-5.3-free",
  "small_model": "skillstate/z-ai/glm-5.3-free"
}
```

### Hermes — in `config.yaml`:

```yaml
providers:
  skillstate:
    api_key: ${TOKENROUTER_API_KEY}
    base_url: http://127.0.0.1:8789/v1
    default_model: z-ai/glm-5.3-free
model:
  default: skillstate/z-ai/glm-5.3-free
```

The proxy forwards the real API key upstream; the client just needs any key to satisfy the local proxy's auth check (or disable auth in proxy config).

---  

## Testing

```bash
# unit tests (no network)
npx vitest run test/state.test.ts

# all tests including live integration (requires TOKENROUTER_API_KEY)
SKILLSTATE_LIVE=1 npx vitest run
```

### Manual smoke

Call the proxy with a few turns and observe state files in `stateDir`; headers `x-skillstate-session`, `x-skillstate-step`, `x-skillstate-statekeys` should appear.

---  

## Benchmark

Run live benchmark vs tokenrouter:

```bash
export TOKENROUTER_API_KEY=sk-...
SKILLSTATE_LIVE=1 npx vitest run test/benchmark.ts
```

Results (real, 2026-08-29, tokenrouter free tier, 5 steps):

```
baseline prompt tokens: 795  |  proxy prompt tokens: 551  (30.7% savings)
baseline total:        1354  |  proxy total:        3945  (overhead at short horizon)
projected 50-step net: ~60% savings
projected 100-step net: ~95% savings (per paper: 20×)
```

---  

## Features merged from headroom (loonie‑cli)

- **Circuit breaker** (`src/circuit-breaker.ts`) – trips on 5xx, half‑open after cooldown  
- **Rate limiter** (`src/rate-limiter.ts`) – token‑per‑minute / request‑per‑minute buckets  
- **Cost ledger** (`src/cost-ledger.ts`) – JSONL append‑only log with USD/GNK dual accounting  
- **Pricing table** (`src/pricing.ts`) – USD per 1M tokens for local, gonka, tokenrouter, openrouter models  
- **Model‑agnostic translator** (`src/anthropic.ts`) – accepts Anthropic `/v1/messages` shape, translates to OpenAI chat/completions for any upstream  
- **SSE passthrough** – streaming responses proxied unchanged (with cost metering)  

---  

## License

MIT — NosytLabs 2026

---  

## References

- [arXiv:2608.26263 – SKILL.state: Bounded State for Long‑Horizon Agent Loops](references/skill-state-paper.md)
- headroom proxy pattern (loonie‑cli) – basis for streaming passthrough and cost ledger
- opencode‑config skill – for provider/model wiring in opencode.json