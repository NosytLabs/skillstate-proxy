import { homedir } from "node:os";
import { join } from "node:path";

export const HARDENING_DEFAULTS = {
  maxStateBytes: 65_536,
  maxPatchBytes: 32_768,
  maxBodyBytes: 1_048_576,
  maxResponseCaptureBytes: 2_097_152,
  connectTimeoutMs: 10_000,
  requestTimeoutMs: 300_000,
  retryMaxAttempts: 3,
  retryAfterCapMs: 5_000,
} as const;

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function requireInteger(name: string, value: unknown, min: number, max?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    throw new Error(`${name} must be an integer between ${min}${max !== undefined ? ` and ${max}` : ""}`);
  }
  return value;
}

function requirePositive(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

function validateUrl(name: string, value: string): void {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error(`${name} upstream URL is invalid: ${value}`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} upstream URL must use http or https`);
  }
}

export type NormalizableConfig = {
  listenPort: number;
  stateDir: string;
  costLedgerPath: string;
  upstreams: Array<{ name: string; url: string; priority: number; [key: string]: unknown }>;
  schema: string[];
  initialState: Record<string, unknown>;
  maxRetries?: number;
  maxBodyBytes?: number;
  maxStateBytes?: number;
  maxPatchBytes?: number;
  maxResponseCaptureBytes?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  retryMaxAttempts?: number;
  retryAfterCapMs?: number;
  [key: string]: unknown;
};

export function normalizeConfigValues<T extends NormalizableConfig>(input: T): T & {
  maxBodyBytes: number;
  maxStateBytes: number;
  maxPatchBytes: number;
  maxResponseCaptureBytes: number;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  retryMaxAttempts: number;
  retryAfterCapMs: number;
} {
  requireInteger("listenPort", input.listenPort, 0, 65_535);
  if (!input.stateDir || typeof input.stateDir !== "string") throw new Error("stateDir must be a path string");
  if (!input.costLedgerPath || typeof input.costLedgerPath !== "string") throw new Error("costLedgerPath must be a path string");
  if (!Array.isArray(input.upstreams) || input.upstreams.length === 0) throw new Error("at least one upstream is required");
  for (const upstream of input.upstreams) {
    if (!upstream || typeof upstream.name !== "string" || !upstream.name) throw new Error("upstream name is required");
    validateUrl(upstream.name, upstream.url);
    if (!Number.isFinite(upstream.priority)) throw new Error(`upstream ${upstream.name} priority must be finite`);
  }
  if (!Array.isArray(input.schema) || !input.schema.every(v => typeof v === "string")) throw new Error("schema must be an array of strings");
  if (!input.initialState || typeof input.initialState !== "object" || Array.isArray(input.initialState)) throw new Error("initialState must be a JSON object");

  const maxBodyBytes = requirePositive("maxBodyBytes", input.maxBodyBytes ?? HARDENING_DEFAULTS.maxBodyBytes);
  const maxStateBytes = requirePositive("maxStateBytes", input.maxStateBytes ?? HARDENING_DEFAULTS.maxStateBytes);
  const maxPatchBytes = requirePositive("maxPatchBytes", input.maxPatchBytes ?? HARDENING_DEFAULTS.maxPatchBytes);
  const maxResponseCaptureBytes = requirePositive("maxResponseCaptureBytes", input.maxResponseCaptureBytes ?? HARDENING_DEFAULTS.maxResponseCaptureBytes);
  const connectTimeoutMs = requirePositive("connectTimeoutMs", input.connectTimeoutMs ?? HARDENING_DEFAULTS.connectTimeoutMs);
  const requestTimeoutMs = requirePositive("requestTimeoutMs", input.requestTimeoutMs ?? HARDENING_DEFAULTS.requestTimeoutMs);
  const retryAfterCapMs = requirePositive("retryAfterCapMs", input.retryAfterCapMs ?? HARDENING_DEFAULTS.retryAfterCapMs);
  const retryMaxAttempts = requireInteger("retryMaxAttempts", input.retryMaxAttempts ?? HARDENING_DEFAULTS.retryMaxAttempts, 1);
  if (input.maxRetries !== undefined) requireInteger("maxRetries", input.maxRetries, 0);

  return {
    ...input,
    stateDir: expandHomePath(input.stateDir),
    costLedgerPath: expandHomePath(input.costLedgerPath),
    schema: input.schema.length ? [...input.schema] : Object.keys(input.initialState),
    upstreams: input.upstreams.map(u => ({ ...u })),
    maxBodyBytes,
    maxStateBytes,
    maxPatchBytes,
    maxResponseCaptureBytes,
    connectTimeoutMs,
    requestTimeoutMs,
    retryMaxAttempts,
    retryAfterCapMs,
  };
}
