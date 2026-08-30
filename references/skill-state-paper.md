# SKILL.state — paper summary

**Title:** *SKILL.state: Scalable Long-Horizon Agent Skills*
**Authors:** Sanket Badhe (Google LLC), Priyanka Tiwari (Google LLC), Jonghyun Chung (Purdue University)
**Venue:** EMNLP 2026
**Link:** [arXiv:2608.26263](https://arxiv.org/abs/2608.26263) · [DOI](https://doi.org/10.48550/arXiv.2608.26263)

This is the paper `skillstate-proxy` implements. The summary below is what an
implementer needs to faithfully enforce the runtime.

---

## 1. The problem

Modern LLM agent runtimes keep execution by *appending* reasoning, actions,
and observations to a growing conversational transcript. As the horizon T
grows:

- prompt size grows as **O(T)**,
- cumulative tokens grow as **O(T²)**,
- obsolete facts and noisy telemetry remain in context and start *poisoning* decisions.

## 2. The proposal

Replace append-only transcripts with an **explicit, mutable execution state Σ**.
At each step t the model receives ONLY:

```
A_t = (P, Σ_t, O_t)
```

- **P** — immutable procedural specification (system prompt / task)
- **Σ_t** — structured execution state (a JSON object, bounded by an author-supplied schema)
- **O_t** — latest environment observation

The model emits **(R_t, ΔΣ_t, a_t)** in a single forward pass:

- **R_t** — reasoning (CoT). **Discarded after the state update is applied.**
- **ΔΣ_t** — `state_patch`: a JSON dictionary of key mutations. Setting a key to `null` deletes it.
- **a_t** — the action to execute next.

```
Σ_{t+1} = Σ_t ⊕ ΔΣ_t       (⊕ = dict merge with null-deletion semantics)
```

The runtime **validates** ΔΣ_t deterministically. On failure → **rollback-retry**
(re-prompt the model). The reasoning R_t is then thrown away; only Σ_{t+1} and
the new observation carry forward.

### 2.1 Expected model reply shape (paper format)

The model outputs a fenced JSON block containing `state_patch` (delta Σ) and `action`:

```
```json
{
  "state_patch": { "key": "new_value", "old_key": null },
  "action":      "<string>"
}
```
```
```

### 2.2 Complexity

|                          | Conversational (baseline) | SKILL.state |
|--------------------------|--------------------------:|------------:|
| Prompt size at step t    | **O(t)**                  | **O(1)** (bounded, independent of T) |
| Cumulative tokens        | **O(T²)**                 | **O(T)**    |

## 3. Schema authoring (§3.1)

- Schemas are **domain-level**, written once per environment type, not per task.
- Example: across all 100 InterCode CTF challenge instances the paper reuses the
  same 5-field schema: `discovered_flags`, `tested_hypotheses`, `active_files`,
  `working_dir`, `cmd_summary`.
- Limitation acknowledged (§7): when the relevant state structure isn't known
  in advance and must be *discovered* during execution, the approach is weaker.

## 4. Benchmarks (§4)

- **SkillExecBench** — controlled long-horizon procedural testbed (Warehouse,
  Software Repo) with controlled scaling, noise, and state-recovery scenarios.
- **InterCode CTF** — interactive Linux terminal exploitation.
- **Sierra τ-Bench** — multi-turn customer-service workflows (Retail, Airline).

## 5. Headline results (selected)

### 5.1 Token reduction (Warehouse, Gemini-3-Flash)

| T   | Baseline (ReAct) | SKILL.state | Reduction |
|----:|-----------------:|------------:|----------:|
| 10  | 9.4 k            | 5.9 k       | ~1.6×     |
| 50  | ~250 k           | ~33 k       | ~7.6×     |
| 100 | 1,245,413        | 65,408      | **~19×**  |
| 200 | 2,608,755        | 122,384     | **~21×**  |

### 5.2 Accuracy (same table)

| T   | Baseline | SKILL.state |
|----:|---------:|------------:|
| 100 | 0.84     | **0.94**    |
| 200 | 0.74     | **0.94**    |

### 5.3 InterCode CTF

| Runtime     | Pass@1  | Total tokens |
|-------------|--------:|-------------:|
| ReAct       | 43.2%   | 977 k        |
| Memory      | 46.4%   | 1.03 M       |
| Stateful    | 41.8%   | 1.13 M       |
| **SKILL.state** | **54.2%** | **387 k** |

### 5.4 Budget-matched controls (T=100, ~1800 tok/step budget)

| Runtime                    | Score |
|----------------------------|------:|
| Truncated (sliding window) | 0.18  |
| Summary-capped             | 0.52  |
| ReAct + LLMLingua          | 0.22  |
| **SKILL.state**            | **0.94** |

→ The gains aren't from "shorter prompts" alone. With the same budget, every
compression/truncation baseline catastrophically fails. The *structure* of Σ
is the active ingredient.

### 5.5 Noise robustness (Warehouse T=50, Gemini-3-Flash)

| Distractors/turn | Prompt (ReAct) | SKILL.state |
|------------------|---------------:|------------:|
| 5                | 0.68           | **1.00**    |
| 20               | 0.61           | **0.97**    |
| 50               | 0.53           | **0.98**    |

### 5.6 State recovery (Experiment 3)

When the true environment changes behind the agent's back (Secret Audit,
Secret Barcode, Secret Move scenarios):
- Baseline runtimes hallucinate for **5–8 consecutive turns** before noticing.
- **SKILL.state: 0 recovery steps.** The corrective observation updates Σ
  immediately because there is no stale history to fight it.

### 5.7 Public interactive benchmarks (Experiment 4, Gemini-3-Flash)

| Runtime | InterCode CTF pass@1 | tokens | τ-Bench Retail | tokens | τ-Bench Airline | tokens |
|---|---:|---:|---:|---:|---:|---:|
| Prompt (ReAct) | 43.2% | 977k | 48.2% | 4.48M | 21.8% | 4.85M |
| Memory (Summary) | 46.4% | 1.03M | 29.9% | 4.24M | 23.6% | 4.65M |
| Stateful (LangGraph) | 41.8% | 1.13M | 51.7% | 3.92M | 28.1% | 5.28M |
| **SKILL.state** | **54.2%** | **387k** | **58.3%** | **3.47M** | **32.4%** | **2.88M** |

In τ-Bench Airline, baseline prompts peak above 11,000 tokens/step (dense DB
responses); SKILL.state stays flat at ~2,800 tokens/step.

### 5.8 Open-weight error taxonomy (§5.7)

Small models (Gemma-4-31B at T=100, score 0.42) fail in three predictable ways:
1. **Premature overwrite / deletion** (68%) — emit a state_patch that replaces
   instead of merges.
2. **Schema comprehension / type coercion** (20%) — list vs dict confusion.
3. **JSON syntax / formatting slips** (12%) — trailing commas, etc.

The paper concludes: *failures are output-formatting failures, not reasoning
failures*, motivating constrained decoding. In `skillstate-proxy` this is
mitigated by (a) rollback-retry on missing/invalid `state_patch`, and
(b) schema enforcement that drops out-of-schema keys with an
`x-skillstate-validation` warning header.

## 6. Limitations (§7)

The paper identifies three settings where the sufficient-statistic assumption fails:

1. **No fixed schema known in advance** — relevant state structure must be
   discovered dynamically during execution.
2. **Deferred-relevance observations** — a correct state update depends on an
   earlier observation whose relevance wasn't recognized when first observed,
   so it was never committed to state.
3. **Trajectory-defined objectives** — auditing, debugging provenance, or
   explaining past actions, where the history itself is the target output.

Additionally: single-agent only (multi-agent needs deterministic conflict
resolution in ⊕ for concurrent writes); relies on the model proposing valid
state patches (malformed outputs trigger rollback-retry, not corruption —
schema ownership and validation live in the runtime); small open-weight models
are format-error-prone (grammar-constrained decoding is future work); schema
authoring is manual (learned schemas are future work).

## 7. Implementation checklist (for a faithful proxy)

- [x] Per-conversation Σ persisted across turns
- [x] Prompt is rebuilt every step as `(P, Σ_t, O_t)` only — no transcript
- [x] Model reply parsed for `state_patch` (ΔΣ_t) + `action` (a_t)
- [x] Deterministic merge Σ ← Σ ⊕ ΔΣ_t with null-deletion
- [x] Reasoning R_t discarded after validated update
- [x] Rollback-retry when ΔΣ_t is missing/invalid
- [x] Schema enforcement (drop out-of-schema keys, surface warnings)
- [x] Streaming passthrough with cost metering
- [x] Multi-upstream failover + circuit breaker + rate limiter
- [x] Anthropic ↔ OpenAI wire translation