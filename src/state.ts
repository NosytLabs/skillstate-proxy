/**
 * SKILL.state runtime core — arXiv:2608.26263 (Badhe, Tiwari, Chung; EMNLP 2026).
 *
 * At each step t the model receives ONLY the triple A_t = (P, Σ_t, O_t):
 *   - P    : immutable procedural specification (system prompt / task)
 *   - Σ_t  : structured execution state (JSON)
 *   - O_t  : latest observation from the environment
 *
 * The model emits (R_t, ΔΣ_t, a_t): reasoning + a `state_patch` ΔΣ_t + an
 * `action` a_t, in a single ```json ... ``` block:
 *
 *   ```json
 *   {
 *     "state_patch": { "key": newValue, "old_key": null },
 *     "action": "<string>"
 *   }
 *   ```
 *
 * Setting a key to `null` deletes it (null-deletion semantics).
 * The runtime validates ΔΣ_t deterministically; on failure it triggers a
 * rollback-retry (the proxy re-prompts the model). On success:
 *
 *     Σ_{t+1} = Σ_t ⊕ ΔΣ_t
 *
 * The reasoning R_t is then DISCARDED permanently and never appears in the
 * next prompt. Prompt size still depends on the specification, retained
 * values and latest observation; this module does not impose a byte budget.
 *
 * §3.1 Schema authoring: schemas are domain-level (e.g. InterCode CTF reuses
 * a single 5-field schema across all 100 instances). State is the ONLY
 * information that survives across steps.
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
 * Recognised encodings (in priority order):
 *   1. **Paper format (preferred).** A fenced ```json block whose top-level
 *      object has a `state_patch` key (aliases: `statePatch` / `delta` /
 *      `state` / `sigma`). May also carry `action` (or `command`).
 *   2. **Legacy fenced block.** A fenced ```json / state / delta / Σ block
 *      whose body IS the state dict (no `state_patch` wrapper).
 *   3. **Inline marker.** `@state {…}` / `STATE: {…}` / `ΔΣ: {…}` / `DELTA: {…}`.
 *   4. **Whole-output JSON.** The entire message is a JSON object that has a
 *      `state_patch` / `state` / `delta` / `sigma` key.
 *
 * Returns:
 *   - `delta`     : the parsed state patch (may be `{}` for a valid no-op).
 *   - `action`    : the model's chosen action string (paper format), else `undefined`.
 *   - `reasoning` : everything outside the JSON block (the discarded R_t).
 *   - `valid`     : `true` iff a paper-format `state_patch` was found.
 *                   The proxy uses this to trigger rollback-retry when the
 *                   model fails to emit a structured state update.
 *   - `format`    : which encoding matched (`"paper"` / `"legacy"` / `"none"`).
 */
export function extractDelta(text: string): {
  delta: Record<string, unknown>;
  action?: string;
  reasoning: string;
  valid: boolean;
  format: "paper" | "legacy" | "none";
} {
  const none = { delta: {}, action: undefined, reasoning: text, valid: false, format: "none" as const };
  const aliases = ["state_patch", "statePatch", "delta", "state", "sigma"];
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const patchKey = (value: Record<string, unknown>) =>
    aliases.find((key) => Object.prototype.hasOwnProperty.call(value, key));
  const actionOf = (value: Record<string, unknown>) => {
    const action = value.action ?? value.command;
    return typeof action === "string" ? action : undefined;
  };

  // Presence and validity determine precedence, never the number of keys.
  // An empty patch is a successful no-op, not an invitation to parse more text.
  let legacy: { delta: Record<string, unknown>; reasoning: string } | undefined;
  let invalidWrapper = false;
  const fences = text.matchAll(/```(?:json|state|delta|sigma|Σ)?[ \t]*(?:\r?\n)?([\s\S]*?)```/gi);
  for (const fence of fences) {
    const obj = tryJson(fence[1]);
    if (!isRecord(obj)) continue;
    const key = patchKey(obj);
    const reasoning = (text.slice(0, fence.index) + text.slice(fence.index + fence[0].length)).trim();
    if (key !== undefined) {
      const patch = obj[key];
      if (isRecord(patch)) {
        return { delta: patch, action: actionOf(obj), reasoning, valid: true, format: "paper" };
      }
      // Do not reinterpret a malformed protocol wrapper as legacy state,
      // or silently use a different alias when the preferred key is invalid.
      invalidWrapper = true;
    } else if (!legacy) {
      legacy = { delta: obj, reasoning };
    }
  }
  if (invalidWrapper) return none;
  if (legacy) return { ...legacy, action: undefined, valid: false, format: "legacy" };

  const inline = text.match(/(?:@state|STATE:|ΔΣ:|DELTA:)\s*(\{[\s\S]*?\})\s*(?:\n|$)/i);
  if (inline) {
    const obj = tryJson(inline[1]);
    if (isRecord(obj)) return { delta: obj, action: undefined, reasoning: text, valid: false, format: "legacy" };
  }

  const whole = tryJson(text.trim());
  if (isRecord(whole)) {
    const key = patchKey(whole);
    const patch = key === undefined ? undefined : whole[key];
    if (isRecord(patch)) {
      return { delta: patch, action: actionOf(whole), reasoning: "", valid: true, format: "paper" };
    }
  }
  return none;
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
 * No history, no prior reasoning. Paper §3.2 prompt template (Appendix A.4).
 */
export function buildStepPrompt(
  session: StateSession,
  observation: string,
  opts: { stateAsSystem?: boolean } = {},
): { system: string; user: string } {
  // Paper §A.4: compact JSON (no whitespace) to minimize prompt tokens
  const stateJson = JSON.stringify(session.state);
  const sys = [
    session.spec,
    "",
    "Skill Execution State:",
    "```json",
    stateJson,
    "```",
  ].join("\n");
  const usr = [
    "Latest Observation:",
    observation,
    "",
    "Provide your response with:",
    "1. Step-by-step reasoning (will be discarded after execution)",
    "2. A JSON block fenced with ```json ... ``` containing both your State Patch and your Action.",
    '   The JSON block MUST have exactly these two keys:',
    '   { "state_patch": { <dict: your state updates, set keys to null to delete> },',
    '     "action": "<string: the exact command you want to execute>" }',
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
 *    dropped; allowed values are not size-bounded by the key list)
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
