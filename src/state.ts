/**
 * SKILL.state runtime core (arXiv:2608.26263).
 *
 * The proxy keeps an explicit, mutable execution state Σ server-side per
 * conversation. At each LLM step the model receives ONLY:
 *   - P  : immutable procedural specification (the system prompt / task)
 *   - Σt : the current structured execution state (a JSON object)
 *   - Ot : the latest observation (the most recent assistant/tool/user turn)
 *
 * The model is asked to emit a structured delta ΔΣ + action. After a validated
 * update, the intermediate reasoning R is DISCARDED. Only Σ_{t+1} = Σt ⊕ ΔΣ
 * survives. ⊕ is a dictionary merge with null-deletion semantics.
 *
 * Complexity: O(1) prompt per step, O(T) cumulative tokens (vs O(T²) for
 * append-only transcript runtimes).
 */

export interface StateSession {
  /** Immutable procedural spec P (set once, usually the system message). */
  spec: string;
  /** Mutable structured execution state Σ. */
  state: Record<string, unknown>;
  /** Schema keys the state is allowed to carry (authored per domain). */
  schema: string[];
  /** Step counter. */
  step: number;
  /** Whether the session has been bootstrapped (spec + initial state set). */
  initialized: boolean;
}

/**
 * Dictionary merge with null-deletion semantics: a key set to null (or
 * undefined) is deleted; otherwise the value overwrites/merges.
 */
export function mergeState(
  base: Record<string, unknown>,
  delta: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(delta)) {
    if (v === null || v === undefined) {
      delete next[k];
    } else if (
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof next[k] === "object" &&
      !Array.isArray(next[k])
    ) {
      // recursive merge for nested objects (e.g. nested state maps)
      next[k] = mergeState(next[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      next[k] = v;
    }
  }
  return next;
}

/**
 * Extract a structured ΔΣ from a model's text output.
 *
 * We support two encodings the model may use:
 *   1. A fenced ```json ... ``` block tagged "state" / "delta" / "Σ".
 *   2. An inline `@state {json}` or `STATE: {json}` marker.
 *   3. A top-level `"state"` / `"delta"` key if the whole output is JSON.
 *
 * Anything outside the delta is treated as the discarded reasoning R.
 * Returns the parsed delta (possibly empty) and the raw "reasoning" remainder.
 */
export function extractDelta(text: string): {
  delta: Record<string, unknown>;
  reasoning: string;
} {
  let delta: Record<string, unknown> = {};
  let reasoning = text;

  // 1. fenced block with a state/delta/Σ tag
  const fence = text.match(/```(?:json|state|delta|sigma|Σ)\s*\n([\s\S]*?)```/i);
  if (fence) {
    const parsed = tryJson(fence[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      delta = parsed as Record<string, unknown>;
      reasoning = text.replace(fence[0], "").trim();
    }
  }

  // 2. inline @state / STATE: marker
  if (Object.keys(delta).length === 0) {
    const inline = text.match(/(?:@state|STATE:|ΔΣ:|DELTA:)\s*(\{[\s\S]*?\})\s*(?:\n|$)/i);
    if (inline) {
      const parsed = tryJson(inline[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        delta = parsed as Record<string, unknown>;
      }
    }
  }

  // 3. whole-output JSON with a state/delta key
  if (Object.keys(delta).length === 0) {
    const whole = tryJson(text.trim());
    if (whole && typeof whole === "object" && !Array.isArray(whole)) {
      const cand = (whole as Record<string, unknown>).state ??
        (whole as Record<string, unknown>).delta ??
        (whole as Record<string, unknown>).sigma;
      if (cand && typeof cand === "object" && !Array.isArray(cand)) {
        delta = cand as Record<string, unknown>;
        reasoning = "";
      }
    }
  }

  // restrict to schema when provided
  return { delta, reasoning };
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s.trim());
  } catch {
    return undefined;
  }
}

/**
 * Build the prompt the upstream model receives: (P, Σ, O) only.
 * No history, no prior reasoning.
 */
export function buildStepPrompt(
  session: StateSession,
  observation: string,
  opts: { stateAsSystem?: boolean } = {},
): { system: string; user: string } {
  const stateJson = JSON.stringify(session.state, null, 2);
  const sys = [
    session.spec,
    "",
    "=== EXECUTION STATE (Σ) ===",
    "This is the ONLY state you retain across steps. Update it via a ```json delta block.",
    "Set a key to null to delete it. Do NOT repeat prior conversation; it is gone.",
    stateJson,
  ].join("\n");
  const usr = [
    "=== LATEST OBSERVATION (O) ===",
    observation,
    "",
    "Respond with: (1) brief reasoning, then (2) a ```json delta block of state mutations, then (3) your action/answer.",
  ].join("\n");
  return { system: sys, user: usr };
}

/**
 * Apply a delta to a session, enforcing schema when present, validating shape
 * (paper §"validated state update"), and increment step.
 *
 * Validation:
 *  - delta must be a plain JSON object (not array, not null)
 *  - each value must be JSON-serializable
 *  - when schema is set, only schema-allowed keys survive (out-of-schema are
 *    dropped — the state never grows beyond the authored contract)
 *
 * Returns the merged state plus a list of validation warnings (dropped keys,
 * unparseable values). The proxy can surface these via response header
 * `x-skillstate-validation`.
 */
export function applyDelta(
  session: StateSession,
  delta: Record<string, unknown>,
): { merged: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = [];
  let safeDelta: Record<string, unknown> = {};
  if (delta && typeof delta === "object" && !Array.isArray(delta)) {
    for (const [k, v] of Object.entries(delta)) {
      if (v === null || v === undefined) { safeDelta[k] = null; continue; }
      try { JSON.stringify(v); safeDelta[k] = v; }
      catch { warnings.push(`dropped non-serializable value at key "${k}"`); }
    }
  } else {
    warnings.push("delta was not a JSON object — ignored");
  }
  let merged = mergeState(session.state, safeDelta);
  if (session.schema.length > 0) {
    const before = Object.keys(merged);
    merged = Object.fromEntries(
      Object.entries(merged).filter(([k]) => session.schema.includes(k)),
    );
    const dropped = before.filter(k => !Object.prototype.hasOwnProperty.call(merged, k));
    if (dropped.length > 0) warnings.push(`dropped out-of-schema keys: ${dropped.join(", ")}`);
  }
  session.state = merged;
  session.step += 1;
  return { merged, warnings };
}

export function newSession(spec: string, initialState: Record<string, unknown>, schema: string[]): StateSession {
  return {
    spec,
    state: { ...initialState },
    schema,
    step: 0,
    initialized: true,
  };
}
