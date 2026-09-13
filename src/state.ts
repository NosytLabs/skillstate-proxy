import { serializeState, DEFAULT_MAX_STATE_BYTES, isPlainRecord } from "./json-state.js";

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
  spec: string;
  state: Record<string, unknown>;
  schema: string[];
  stateTypes?: Record<string, StateValueKind>;
  step: number;
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
  if (typeof v === "string") return "string";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
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

export function validateTransition(
  session: StateSession,
  transition: PaperTransition,
  options: TransitionValidationOptions = {},
): TransitionValidationResult {
  const errors: string[] = [];
  const raw: unknown = transition;
  if (!isPlainRecord(raw)) return { ok: false, errors: ["transition must be a plain JSON object"] };
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== 2 || !keys.includes("state_patch") || !keys.includes("action")) {
    errors.push("transition envelope must contain exactly state_patch and action");
  }
  const patchField = Object.getOwnPropertyDescriptor(raw, "state_patch");
  const actionField = Object.getOwnPropertyDescriptor(raw, "action");
  if (!patchField || !("value" in patchField) || !patchField.enumerable || !isPlainRecord(patchField.value)) errors.push("state_patch must be a JSON data object");
  if (!actionField || !("value" in actionField) || !actionField.enumerable || typeof actionField.value !== "string") errors.push("action must be a string data property");
  if (errors.length) return { ok: false, errors };

  const patch = patchField!.value as Record<string, unknown>;

  const maxPatchBytes = options.maxPatchBytes ?? 32_768;
  const maxStateBytes = options.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES;
  try {
    serializeState(session.state, maxStateBytes, "current state");
    serializeState(patch, maxPatchBytes, "state patch");
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : "invalid JSON state"] };
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
  try { serializeState(candidateState, maxStateBytes, "merged state"); }
  catch (error) { errors.push(error instanceof Error ? error.message : "invalid merged state"); }

  return errors.length ? { ok: false, errors } : { ok: true, candidateState, errors: [] };
}

export function commitTransition(session: StateSession, candidateState: Record<string, unknown>): void {
  session.state = structuredClone(candidateState);
  session.step += 1;
}

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
