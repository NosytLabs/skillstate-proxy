# SKILL.state — paper summary

**Title:** *SKILL.state: Scalable Long-Horizon Agent Skills*
**Authors:** Sanket Badhe (Google), Priyanka Tiwari (Google), Jonghyun Chung (Purdue)
**Venue:** EMNLP 2026
**Link:** [arXiv:2608.26263](https://arxiv.org/abs/2608.26263)

---

## The problem

LLM agent runtimes append reasoning, actions, and observations to a growing transcript. As horizon T grows:

- Prompt size: **O(T)**, cumulative tokens: **O(T²)**
- Stale facts poison decisions; noisy telemetry distracts the model
- Budget-matched compression baselines (sliding window, summary, LLMLingua) catastrophically fail

## The proposal

Replace append-only transcripts with **explicit, mutable execution state Σ**. At each step t the model receives ONLY:

```
A_t = (P, Σ_t, O_t)
```

- **P** — immutable procedural specification (system prompt / task)
- **Σ_t** — structured execution state (JSON, bounded by author-supplied schema)
- **O_t** — latest environment observation

The model emits **(R_t, ΔΣ_t, a_t)** in a single forward pass:

- **R_t** — reasoning. **Discarded after state update.**
- **ΔΣ_t** — `state_patch`: JSON dict of key mutations. `null` deletes.
- **a_t** — action to execute next.

```
Σ_{t+1} = Σ_t ⊕ ΔΣ_t       (dict merge with null-deletion)
```

On invalid ΔΣ_t → **rollback-retry** (re-prompt). Complexity: O(1) per-step prompt, O(T) cumulative tokens.

## Key results

| T | Baseline tokens | SKILL.state | Reduction | Accuracy (baseline → SKILL.state) |
|--:|---:|---:|---:|---:|
| 50 | 250k | 33k | 7.6x | 0.79 → **0.96** |
| 100 | 1.25M | 65k | **19x** | 0.84 → **0.94** |
| 200 | 2.61M | 122k | **21x** | 0.74 → **0.94** |

Budget-matched (T=100): SKILL.state **0.94** vs sliding window 0.18, summary 0.52, LLMLingua 0.22.

InterCode CTF: **54.2%** pass@1 vs 43.2% ReAct, 60% fewer tokens.
τ-Bench: **58.3%** Retail, **32.4%** Airline (highest across all baselines).

Noise robustness: **0.98** accuracy with 50 distractors/turn vs 0.53 baseline.
State recovery: **0 steps** after environment drift vs 5-8 turns hallucinating.

## Open-weight error taxonomy (§5.7)

Small models (Gemma-4-31B at T=100, score 0.42) fail in predictable ways:
1. **Premature overwrite** (68%) — replace instead of merge
2. **Type coercion** (20%) — list vs dict confusion
3. **JSON syntax** (12%) — trailing commas, etc.

Failures are **output-formatting**, not reasoning — motivating constrained decoding.

## Limitations (§7)

1. **No fixed schema in advance** — state structure must be discovered dynamically
2. **Deferred-relevance observations** — earlier observation's importance not recognized
3. **Trajectory-defined objectives** — auditing, provenance, "explain what you did"

Single-agent only. Multi-agent needs deterministic conflict resolution in ⊕.

## Implementation checklist (proxy)

- [x] Per-conversation Σ persisted across turns
- [x] Prompt rebuilt as `(P, Σ_t, O_t)` only — no transcript
- [x] Model reply parsed for `state_patch` + `action`
- [x] Deterministic merge with null-deletion
- [x] Reasoning discarded after validated update
- [x] Rollback-retry on missing/invalid ΔΣ
- [x] Schema enforcement (drop out-of-schema keys)
- [x] Streaming passthrough with cost metering
- [x] Multi-upstream failover + circuit breaker + rate limiter
- [x] Anthropic ↔ OpenAI wire translation

## Related work

- **SkillGate** (arXiv:2608.18852) — in-policy skill selection; complementary
- **LatentSkill** (arXiv:2606.06087) — textual skills → LoRA adapters; weight-space vs context-space
- **SkillSmith** (arXiv:2605.15215) — boundary-guided runtime interfaces; orthogonal
- **Recuris** (arXiv:2608.24876) — recursive working memory; same "growing history" insight
- **SWE-TRACE** (arXiv:2604.14820) — rubric process rewards for SWE agents
- **SkillCraft** (arXiv:2603.00718) — tool composition benchmarks
- **SIRI** (arXiv:2606.02355) — self-internalizing RL with intrinsic skills
- **Context compression** (arXiv:2604.19572) — observational compression for terminal agents
