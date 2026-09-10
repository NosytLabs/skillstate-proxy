/**
 * SKILL.state runtime core — arXiv:2608.26263 (Badhe, Tiwari, Chung; EMNLP 2026).
 *
 * At each step t the model receives ONLY the triple A_t = (P, Σ_t, O_t):
 *   - P    : immutable procedural specification (system prompt / task)
 *   - Σ_t  : structured execution state (JSON)
 *   - O_t  : latest observation from the environment
 *
 * Persistent proxy transitions use the paper envelope:
 *   { "state_patch": { ... }, "action": "..." }
 *
 * State mutation is transactional: parse -> validate -> candidate -> commit.
 */

export type StateValueKind = "string" | "number" | "boolean" | "array" | "object";

export interface StateSession {
  /** Immutable procedural spec P (set once, usually the system message). */
  spec: string;
  /** Mutable structured execution state Σ. */
  state: Record<string, unknown>;
  /** Schema keys the state is allowed to carry (authored per domain). */
  schema: string[];
  /** Top-level type contract inferred at session creation when possible. */
  stateTypes?: Record<string, StateValueKind>;
  /** Step counter. */
  step: number;
  /** Whether the session has been bootstrapped (spec + initial state set). */
  initialized: boolean;
}

export interface PaperTransition {
  state_patch: Record<string, unknown>;
  action: string;
}

export interface ParsedPaperTransition {
  ok: boolean;
  transition?: PaperTransition;
  reasoning: string;
  errors: string[];
}

export interface TransitionValidationOptions {
  maxPatchBytes?: number;
  maxStateBytes?: number;
  stateTypes?: Record<string, StateValueKind>;
}

export interface TransitionValidationResult {
  ok: boolean;
  candidateState?: Record<string, unknown>;
  errors: string[];
}

/** Dictionary merge with null-deletion semantics. */
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
      next[k] !== null &&
      !Array.isArray(next[k])
    ) {
      next[k] = mergeState(next[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      next[k] = v;
    }
  }
  return next;
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s.trim());
  } catch {
    return undefined;
  }
}

function plainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function valueKind(v: unknown): StateValueKind | undefined {
  if (Array.isArray(v)) return "array";
  if (v !== null && typeof v === "object") return "object";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return typeof v;
  return undefined;
}

function inferTypes(state: Record<string, unknown>): Record<string, StateValueKind> {
  const out: Record<string, StateValueKind> = {};
  for (const [key, value] of Object.entries(state)) {
    const kind = valueKind(value);
    if (kind) out[key] = kind;
  }
  return out;
}

function serializedBytes(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? Buffer.byteLength(text, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * Strict parser used by the proxy before persistent state mutation.
 * The transition envelope has exactly state_patch and action; aliases/legacy
 * forms remain supported only by extractDelta() for library backwards compatibility.
 */
export function parsePaperTransition(text: string): ParsedPaperTransition {
  let candidateText = text.trim();
  let reasoning = "";
  const fence = text.match(/```json\s*\n?([\s\S]*?)```/i);
  if (fence) {
    candidateText = fence[1]!.trim();
    reasoning = text.replace(fence[0], "").trim();
  }

  const parsed = tryJson(candidateText);
  if (!plainObject(parsed)) {
    return { ok: false, reasoning, errors: ["transition must be a JSON object"] };
  }

  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "action" || keys[1] !== "state_patch") {
    return {
      ok: false,
      reasoning,
      errors: ["transition envelope must contain exactly state_patch and action"],
    };
  }
  if (!plainObject(parsed.state_patch)) {
    return { ok: false, reasoning, errors: ["state_patch must be a JSON object"] };
  }
  if (typeof parsed.action !== "string") {
    return { ok: false, reasoning, errors: ["action must be a string"] };
  }

  return {
    ok: true,
    reasoning,
    transition: { state_patch: parsed.state_patch, action: parsed.action },
    errors: [],
  };
}

/** Validate a proposed transition without mutating the live session. */
export function validateTransition(
  session: StateSession,
  transition: PaperTransition,
  options: TransitionValidationOptions = {},
): TransitionValidationResult {
  const errors: string[] = [];
  const raw = transition as unknown as Record<string, unknown>;
  const keys = plainObject(raw) ? Object.keys(raw).sort() : [];
  if (keys.length !== 2 || keys[0] !== "action" || keys[1] !== "state_patch") {
    errors.push("transition envelope must contain exactly state_patch and action");
  }
  if (!plainObject(transition?.state_patch)) errors.push("state_patch must be a JSON object");
  if (typeof transition?.action !== "string") errors.push("action must be a string");
  if (errors.length) return { ok: false, errors };

  const patch = transition.state_patch;
  const patchBytes = serializedBytes(patch);
  if (patchBytes === null) errors.push("state patch is not JSON-serializable");
  const maxPatchBytes = options.maxPatchBytes ?? 32_768;
  if (patchBytes !== null && patchBytes > maxPatchBytes) {
    errors.push(`state patch exceeds maxPatchBytes (${patchBytes} > ${maxPatchBytes})`);
  }

  const schema = session.schema;
  if (schema.length > 0) {
    for (const key of Object.keys(patch)) {
      if (!schema.includes(key)) errors.push(`state key "${key}" is outside the configured schema`);
    }
  }

  const contract = { ...(session.stateTypes ?? inferTypes(session.state)), ...(options.stateTypes ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) continue;
    const expected = contract[key];
    const actual = valueKind(value);
    if (expected && actual !== expected) {
      errors.push(`state key "${key}" expected ${expected}, received ${actual ?? typeof value}`);
    }
  }

  if (errors.length) return { ok: false, errors };

  const candidateState = mergeState(session.state, patch);
  const stateBytes = serializedBytes(candidateState);
  if (stateBytes === null) errors.push("merged state is not JSON-serializable");
  const maxStateBytes = options.maxStateBytes ?? 65_536;
  if (stateBytes !== null && stateBytes > maxStateBytes) {
    errors.push(`merged state exceeds maxStateBytes (${stateBytes} > ${maxStateBytes})`);
  }

  return errors.length ? { ok: false, errors } : { ok: true, candidateState, errors: [] };
}

/** Commit one already-validated logical transition. */
export function commitTransition(session: StateSession, candidateState: Record<string, unknown>): void {
  session.state = structuredClone(candidateState);
  session.step += 1;
}

/**
 * Extract a structured ΔΣ from a model's text output.
 *
 * This is the permissive compatibility parser exposed by the library. The proxy
 * uses parsePaperTransition() when deciding whether persistent state may change.
 */
export function extractDelta(text: string): {
  delta: Record<string, unknown>;
  action?: string;
  reasoning: string;
  valid: boolean;
  format: "paper" | "legacy" | "none";
} {
  let delta: Record<string, unknown> = {};
  let action: string | undefined;
  let reasoning = text;
  let format: "paper" | "legacy" | "none" = "none";
  let valid = false;

  const pickPatch = (o: Record<string, unknown>) =>
    (o.state_patch ?? o.statePatch ?? o.delta ?? o.state ?? o.sigma) as unknown | undefined;
  const pickAction = (o: Record<string, unknown>): string | undefined => {
    const a = o.action ?? o.command;
    return typeof a === "string" ? a : undefined;
  };

  const fence = text.match(/```(?:json|state|delta|sigma|Σ)?\s*\n?([\s\S]*?)```/i);
  if (fence) {
    const parsed = tryJson(fence[1]!);
    if (plainObject(parsed)) {
      const sp = pickPatch(parsed);
      if (plainObject(sp)) {
        delta = sp;
        action = pickAction(parsed);
        format = "paper";
        valid = true;
        reasoning = text.replace(fence[0], "").trim();
      } else {
        delta = parsed;
        format = "legacy";
        reasoning = text.replace(fence[0], "").trim();
      }
    }
  }

  if (Object.keys(delta).length === 0) {
    const inline = text.match(/(?:@state|STATE:|ΔΣ:|DELTA:)\s*(\{[\s\S]*?\})\s*(?:\n|$)/i);
    if (inline) {
      const parsed = tryJson(inline[1]!);
      if (plainObject(parsed)) {
        delta = parsed;
        format = "legacy";
      }
    }
  }

  if (Object.keys(delta).length === 0) {
    const whole = tryJson(text.trim());
    if (plainObject(whole)) {
      const sp = pickPatch(whole);
      if (plainObject(sp)) {
        delta = sp;
        action = pickAction(whole);
        format = "paper";
        valid = true;
        reasoning = "";
      } else if (sp && typeof sp === "object") {
        delta = sp as Record<string, unknown>;
        format = "legacy";
        reasoning = "";
      }
    }
  }

  return { delta, action, reasoning, valid, format };
}

/** Build the prompt the upstream model receives: (P, Σ, O) only. */
export function buildStepPrompt(
  session: StateSession,
  observation: string,
  opts: { stateAsSystem?: boolean } = {},
): { system: string; user: string } {
  void opts;
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
    "   The JSON block MUST have exactly these two keys:",
    '   { "state_patch": { <dict: your state updates, set keys to null to delete> },',
    '     "action": "<string: the exact command you want to execute>" }',
  ].join("\n");
  return { system: sys, user: usr };
}

/**
 * Backwards-compatible direct delta application. Proxy orchestration should use
 * validateTransition() + commitTransition() instead.
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
    merged = Object.fromEntries(Object.entries(merged).filter(([k]) => session.schema.includes(k)));
    const dropped = before.filter(k => !Object.prototype.hasOwnProperty.call(merged, k));
    if (dropped.length > 0) warnings.push(`dropped out-of-schema keys: ${dropped.join(", ")}`);
  }
  session.state = merged;
  session.step += 1;
  return { merged, warnings };
}

export function newSession(spec: string, initialState: Record<string, unknown>, schema: string[]): StateSession {
  const effectiveSchema = schema.length > 0 ? [...schema] : Object.keys(initialState);
  return {
    spec,
    state: structuredClone(initialState),
    schema: effectiveSchema,
    stateTypes: inferTypes(initialState),
    step: 0,
    initialized: true,
  };
}
