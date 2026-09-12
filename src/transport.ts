import { readBoundedText, ResponseLimitError } from "./response-body.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import type { RateLimiter } from "./rate-limiter.js";
import { buildUpstreamHeaders } from "./headers.js";
import { extractUsage } from "./token-estimate.js";

export interface TransportUpstream {
  name: string;
  url: string;
  apiKey?: string;
  priority: number;
  headers?: Record<string, string>;
}

export interface TransportAttempt {
  upstream: string;
  attempt: number;
  status?: number;
  error?: string;
  localRateLimit?: boolean;
  circuitOpen?: boolean;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface RequestUpstreamOptions {
  upstreams: TransportUpstream[];
  path: string;
  method: string;
  body?: string;
  incomingHeaders: Record<string, string | string[] | undefined>;
  estimatedTokens: number;
  limiters: Map<string, RateLimiter>;
  breakers: Map<string, CircuitBreaker>;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  retryMaxAttempts: number;
  retryAfterCapMs: number;
  signal?: AbortSignal;
  maxResponseBytes?: number;
}

export interface SelectedUpstream {
  upstream: TransportUpstream;
  response: Response;
  attempts: TransportAttempt[];
  controller: AbortController;
  finish: () => void;
}

export class TransportError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
    public readonly attempts: TransportAttempt[],
  ) {
    super(message);
    this.name = "TransportError";
  }
}

function targetUrl(base: string, path: string): string {
  const url = new URL(base);
  let basePath = url.pathname.replace(/\/$/, "");
  if (path.startsWith("/v1/") && basePath.endsWith("/v1")) basePath = basePath.slice(0, -3);
  return `${url.origin}${basePath}${path}`;
}

function retryAfterMs(value: string | null, capMs: number, attempt: number): number {
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      const ms = seconds * 1000;
      if (ms <= capMs) return ms;
    } else {
      const when = Date.parse(value);
      if (Number.isFinite(when)) {
        const ms = Math.max(0, when - Date.now());
        if (ms <= capMs) return ms;
      }
    }
  }
  const exponential = Math.min(capMs, 100 * 2 ** Math.max(0, attempt - 1));
  return Math.min(capMs, Math.round(exponential * (0.75 + Math.random() * 0.5)));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("aborted"));
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function attemptController(connectMs: number, requestMs: number, parent?: AbortSignal) {
  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(new Error("upstream connect timeout")), connectMs);
  const requestTimer = setTimeout(() => controller.abort(new Error("upstream request timeout")), requestMs);
  const onParentAbort = () => controller.abort(parent?.reason ?? new Error("client aborted"));
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  let finished = false;
  return {
    controller,
    connected() { clearTimeout(connectTimer); },
    finish() {
      if (finished) return;
      finished = true;
      clearTimeout(connectTimer);
      clearTimeout(requestTimer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function addUsage(attempt: TransportAttempt, body: string): void {
  const usage = extractUsage(body);
  if (!usage) return;
  attempt.model = usage.model;
  attempt.inputTokens = usage.inputTokens;
  attempt.outputTokens = usage.outputTokens;
}

export async function requestUpstream(options: RequestUpstreamOptions): Promise<SelectedUpstream> {
  const attempts: TransportAttempt[] = [];
  let lastStatus = 502;
  let lastBody = JSON.stringify({ error: "all upstreams failed" });
  const upstreams = [...options.upstreams].sort((a, b) => a.priority - b.priority);

  for (const upstream of upstreams) {
    const limiter = options.limiters.get(upstream.name);
    const breaker = options.breakers.get(upstream.name);
    if (!limiter || !breaker) continue;

    for (let attempt = 1; attempt <= options.retryMaxAttempts; attempt++) {
      if (options.signal?.aborted) {
        throw new TransportError("downstream request aborted", 499, '{"error":"downstream request aborted"}', attempts);
      }
      const allowed = limiter.check(options.estimatedTokens);
      if (!allowed.ok) {
        attempts.push({ upstream: upstream.name, attempt, status: 429, localRateLimit: true });
        lastStatus = 429;
        lastBody = JSON.stringify({ error: `rate-limited by ${upstream.name}`, retryAfter: allowed.retryAfter ?? 60 });
        break;
      }
      if (!breaker.canAttempt()) {
        attempts.push({ upstream: upstream.name, attempt, status: 503, circuitOpen: true });
        lastStatus = 503;
        lastBody = JSON.stringify({ error: `circuit[${upstream.name}] open` });
        break;
      }

      limiter.record(options.estimatedTokens);
      const lifecycle = attemptController(options.connectTimeoutMs, options.requestTimeoutMs, options.signal);
      let response: Response;
      try {
        response = await fetch(targetUrl(upstream.url, options.path), {
          method: options.method,
          headers: buildUpstreamHeaders(options.incomingHeaders, upstream),
          ...(options.body !== undefined ? { body: options.body } : {}),
          signal: lifecycle.controller.signal,
        });
        lifecycle.connected();
      } catch (error: any) {
        lifecycle.finish();
        breaker.recordFailure();
        attempts.push({ upstream: upstream.name, attempt, error: error?.message ?? String(error) });
        lastStatus = 502;
        lastBody = JSON.stringify({ error: error?.message ?? String(error) });
        if (options.signal?.aborted) throw new TransportError("downstream request aborted", 499, lastBody, attempts);
        if (attempt < options.retryMaxAttempts) {
          await sleep(retryAfterMs(null, options.retryAfterCapMs, attempt), options.signal);
          continue;
        }
        break;
      }

      const attemptRow: TransportAttempt = { upstream: upstream.name, attempt, status: response.status };
      attempts.push(attemptRow);

      if (isRetryable(response.status)) {
        breaker.recordFailure();
        lastStatus = response.status;
        try {
          lastBody = await readBoundedText(response, options.maxResponseBytes ?? 1024 * 1024);
          addUsage(attemptRow, lastBody);
        } catch (error) {
          lifecycle.controller.abort(error);
          if (error instanceof ResponseLimitError) {
            throw new TransportError(error.message, 502, JSON.stringify({ error: error.message }), attempts);
          }
          throw error;
        } finally { lifecycle.finish(); }
        const delay = retryAfterMs(response.headers.get("retry-after"), options.retryAfterCapMs, attempt);
        lifecycle.finish();
        if (attempt < options.retryMaxAttempts) {
          await sleep(delay, options.signal);
          continue;
        }
        break;
      }

      if (response.status === 401 || response.status === 403) {
        lastStatus = response.status;
        try {
          lastBody = await readBoundedText(response, options.maxResponseBytes ?? 1024 * 1024);
          addUsage(attemptRow, lastBody);
        } catch (error) {
          lifecycle.controller.abort(error);
          if (error instanceof ResponseLimitError) {
            throw new TransportError(error.message, 502, JSON.stringify({ error: error.message }), attempts);
          }
          throw error;
        } finally { lifecycle.finish(); }
        lifecycle.finish();
        break;
      }

      breaker.recordSuccess();
      return {
        upstream,
        response,
        attempts,
        controller: lifecycle.controller,
        finish: lifecycle.finish,
      };
    }
  }

  throw new TransportError(`upstream request failed with status ${lastStatus}`, lastStatus, lastBody, attempts);
}
