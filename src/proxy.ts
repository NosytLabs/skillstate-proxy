/**
 * skillstate-proxy — paper-faithful SKILL.state HTTP proxy.
 *
 * Request path: normalize protocol -> acquire session -> rewrite to (P, Σ, O)
 * -> bounded upstream transport -> validate transition -> atomically persist.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  buildStepPrompt,
  commitTransition,
  newSession,
  parsePaperTransition,
  validateTransition,
  type StateSession,
  type StateValueKind,
} from "./state.js";
import { latestObservation } from "./observation.js";
import { estimateTokens, extractUsage } from "./token-estimate.js";
import { CostLedger } from "./cost-ledger.js";
import { CircuitBreaker, type CircuitBreakerConfig } from "./circuit-breaker.js";
import { RateLimiter } from "./rate-limiter.js";
import { gonkaCost, lookupPricing, type UpstreamPricing } from "./pricing.js";
import {
  AnthropicCompatibilityError,
  AnthropicStreamAdapter,
  denormalizeResponse,
  normalizeIncoming,
  type NormalizedRequest,
} from "./anthropic.js";
import { SessionStore, safeSessionId } from "./session-store.js";
import { corsHeaders } from "./headers.js";
import { normalizeConfigValues, HARDENING_DEFAULTS } from "./config.js";
import {
  requestUpstream,
  TransportError,
  type SelectedUpstream,
  type TransportAttempt,
} from "./transport.js";
import { OpenAIStreamObserver, SseParser } from "./sse.js";

export interface UpstreamConfig {
  name: string;
  url: string;
  apiKey?: string;
  priority: number;
  tpm?: number;
  rpm?: number;
  currency?: "usd" | "gnk";
  headers?: Record<string, string>;
  pricing?: UpstreamPricing;
}

export interface ProxyConfig {
  listenPort: number;
  upstreams: UpstreamConfig[];
  stateDir: string;
  schema: string[];
  initialState: Record<string, unknown>;
  discardReasoning: boolean;
  costLedgerPath: string;
  maxRetries?: number;
  maxBodyBytes?: number;
  sessionTtlMs?: number;
  cors?: boolean;
  circuitBreaker?: CircuitBreakerConfig;
  verbose?: boolean;
  maxStateBytes?: number;
  maxPatchBytes?: number;
  maxResponseCaptureBytes?: number;
  stateTypes?: Record<string, StateValueKind>;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  retryMaxAttempts?: number;
  retryAfterCapMs?: number;
}

export const DEFAULT_CONFIG: ProxyConfig = {
  listenPort: 8789,
  upstreams: [{ name: "openai", url: "https://api.openai.com/v1", priority: 0 }],
  stateDir: join(process.env.HOME ?? "/tmp", ".skillstate/state"),
  schema: [],
  initialState: {},
  discardReasoning: true,
  costLedgerPath: join(process.env.HOME ?? "/tmp", ".skillstate/spend.jsonl"),
  maxRetries: 2,
  maxBodyBytes: HARDENING_DEFAULTS.maxBodyBytes,
  sessionTtlMs: 24 * 60 * 60 * 1000,
  cors: true,
  maxStateBytes: HARDENING_DEFAULTS.maxStateBytes,
  maxPatchBytes: HARDENING_DEFAULTS.maxPatchBytes,
  maxResponseCaptureBytes: HARDENING_DEFAULTS.maxResponseCaptureBytes,
  connectTimeoutMs: HARDENING_DEFAULTS.connectTimeoutMs,
  requestTimeoutMs: HARDENING_DEFAULTS.requestTimeoutMs,
  retryMaxAttempts: HARDENING_DEFAULTS.retryMaxAttempts,
  retryAfterCapMs: HARDENING_DEFAULTS.retryAfterCapMs,
};

type RuntimeConfig = ProxyConfig & Required<Pick<ProxyConfig,
  "maxRetries" | "maxBodyBytes" | "sessionTtlMs" | "cors" | "maxStateBytes" |
  "maxPatchBytes" | "maxResponseCaptureBytes" | "connectTimeoutMs" |
  "requestTimeoutMs" | "retryMaxAttempts" | "retryAfterCapMs"
>>;

type TransitionResult = {
  status: "valid" | "invalid" | "tool-noop";
  errors: string[];
  action?: string;
  committed: boolean;
};

type MeterTotals = {
  knownUsd: number;
  knownGnk: number;
  knownUsdRows: number;
  unknownPricing: boolean;
  usageUnavailable: boolean;
};

function reqPath(url?: string): string {
  if (!url) return "";
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new Error(`request body exceeded ${maxBytes} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function getSessionId(req: IncomingMessage): string {
  const raw = req.headers["x-skillstate-session"];
  if (typeof raw === "string") {
    const sid = safeSessionId(raw);
    if (sid) return sid;
  }
  return randomUUID();
}

function rewriteBody(body: any, session: StateSession): { body: any; observation: string } {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  const observation = latestObservation(messages);
  const { system, user } = buildStepPrompt(session, observation);
  const { system: _dropSystem, messages: _dropMessages, ...rest } = body ?? {};
  return {
    body: {
      ...rest,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    },
    observation,
  };
}

function setCors(res: ServerResponse): void {
  for (const [name, value] of Object.entries(corsHeaders())) res.setHeader(name, value);
}

const RESPONSE_HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length", "content-encoding",
]);

function copyUpstreamResponseHeaders(response: Response, res: ServerResponse): void {
  response.headers.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (RESPONSE_HOP_BY_HOP.has(name) || name.startsWith("x-skillstate-")) return;
    res.setHeader(name, value);
  });
}

function setCommonHeaders(
  res: ServerResponse,
  sid: string,
  session: StateSession,
  upstreamName: string,
  transition: TransitionResult["status"] | "pending",
  errors: string[] = [],
  extras: Record<string, string> = {},
): void {
  res.setHeader("x-skillstate-session", sid);
  res.setHeader("x-skillstate-step", String(session.step));
  res.setHeader("x-skillstate-statekeys", Object.keys(session.state).join(","));
  res.setHeader("x-skillstate-upstream", upstreamName);
  res.setHeader("x-skillstate-transition", transition);
  if (errors.length) res.setHeader("x-skillstate-validation", errors.join("|").slice(0, 4000));
  for (const [name, value] of Object.entries(extras)) res.setHeader(name, value);
}

function cleanToolCalls(json: any): any[] {
  const raw = json?.choices?.[0]?.message?.tool_calls;
  const calls = Array.isArray(raw)
    ? raw.filter((call: any) => call?.type === "function" && typeof call?.function?.name === "string")
    : [];
  if (json?.choices?.[0]?.message) {
    if (calls.length) json.choices[0].message.tool_calls = calls;
    else delete json.choices[0].message.tool_calls;
  }
  return calls;
}

function evaluateTransition(
  session: StateSession,
  content: string,
  toolCalls: any[],
  config: RuntimeConfig,
): TransitionResult {
  const parsed = parsePaperTransition(content);

  if (toolCalls.length > 0) {
    if (parsed.ok && parsed.transition) {
      const validation = validateTransition(session, parsed.transition, {
        maxPatchBytes: config.maxPatchBytes,
        maxStateBytes: config.maxStateBytes,
        stateTypes: config.stateTypes,
      });
      if (validation.ok && validation.candidateState) {
        commitTransition(session, validation.candidateState);
        return { status: "valid", errors: [], action: parsed.transition.action, committed: true };
      }
      commitTransition(session, session.state);
      return { status: "tool-noop", errors: validation.errors, committed: true };
    }
    commitTransition(session, session.state);
    return { status: "tool-noop", errors: [], committed: true };
  }

  if (!parsed.ok || !parsed.transition) {
    return { status: "invalid", errors: parsed.errors, committed: false };
  }
  const validation = validateTransition(session, parsed.transition, {
    maxPatchBytes: config.maxPatchBytes,
    maxStateBytes: config.maxStateBytes,
    stateTypes: config.stateTypes,
  });
  if (!validation.ok || !validation.candidateState) {
    return { status: "invalid", errors: validation.errors, action: parsed.transition.action, committed: false };
  }
  commitTransition(session, validation.candidateState);
  return { status: "valid", errors: [], action: parsed.transition.action, committed: true };
}

function correctionRequest(serialized: string, errors: string[]): string {
  try {
    const body = JSON.parse(serialized);
    const user = body?.messages?.[1];
    if (user && typeof user.content === "string") {
      const detail = errors.length ? ` Validation errors: ${errors.join("; ").slice(0, 800)}.` : "";
      user.content += `\n\n[CORRECTION: Your previous reply was not a valid SKILL.state transition.${detail} Reply again with brief reasoning followed by exactly one JSON block containing exactly {\"state_patch\": {...}, \"action\": \"...\"}.]`;
    }
    return JSON.stringify(body);
  } catch {
    return serialized;
  }
}

function modelFromBody(body: any, fallback = ""): string {
  return typeof body?.model === "string" ? body.model : fallback;
}

function addMeteredCost(
  totals: MeterTotals,
  upstream: UpstreamConfig,
  model: string,
  inputTokens: number,
  outputTokens: number,
): { costUsd?: number; costGnk?: number; pricingStatus: "known" | "unknown" | "local-zero" } {
  const pricing = lookupPricing(model, upstream.pricing);
  const usd = pricing.costFor(inputTokens, outputTokens);
  if (usd === null) totals.unknownPricing = true;
  else {
    totals.knownUsd += usd;
    totals.knownUsdRows += 1;
  }
  const gnk = upstream.currency === "gnk" ? gonkaCost(inputTokens + outputTokens).gnk : undefined;
  if (gnk !== undefined) totals.knownGnk += gnk;
  return {
    ...(usd !== null ? { costUsd: usd } : {}),
    ...(gnk !== undefined ? { costGnk: gnk } : {}),
    pricingStatus: pricing.status,
  };
}

function meterGeneration(
  ledger: CostLedger,
  totals: MeterTotals,
  upstream: UpstreamConfig,
  model: string,
  rawBody: string,
  attemptKind: "generation" | "rollback-retry" | "stream",
): { inputTokens: number; outputTokens: number } {
  const usage = extractUsage(rawBody);
  if (!usage) {
    totals.usageUnavailable = true;
    return { inputTokens: 0, outputTokens: 0 };
  }
  const usedModel = model || usage.model;
  const costs = addMeteredCost(totals, upstream, usedModel, usage.inputTokens, usage.outputTokens);
  ledger.record({
    ts: new Date().toISOString(),
    upstream: upstream.name,
    model: usedModel,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...costs,
    attemptKind,
  });
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}

function meterTransportAttempts(
  ledger: CostLedger,
  totals: MeterTotals,
  attempts: TransportAttempt[],
  configuredUpstreams: UpstreamConfig[],
  fallbackModel: string,
): void {
  for (const attempt of attempts) {
    if (typeof attempt.inputTokens !== "number" || typeof attempt.outputTokens !== "number") continue;
    const upstream = configuredUpstreams.find(candidate => candidate.name === attempt.upstream);
    if (!upstream) continue;
    const model = attempt.model || fallbackModel;
    const costs = addMeteredCost(totals, upstream, model, attempt.inputTokens, attempt.outputTokens);
    ledger.record({
      ts: new Date().toISOString(),
      upstream: upstream.name,
      model,
      inputTokens: attempt.inputTokens,
      outputTokens: attempt.outputTokens,
      ...costs,
      attemptKind: "transport-retry",
    });
  }
}

function costHeaders(totals: MeterTotals): Record<string, string> {
  const extras: Record<string, string> = {};
  if (totals.knownUsdRows > 0) extras["x-skillstate-cost-usd"] = totals.knownUsd.toFixed(6);
  if (totals.knownGnk > 0) extras["x-skillstate-cost-gnk"] = totals.knownGnk.toFixed(6);
  if (totals.unknownPricing) extras["x-skillstate-pricing"] = totals.knownUsdRows > 0 ? "partial" : "unknown";
  else if (totals.usageUnavailable) extras["x-skillstate-pricing"] = "usage-unavailable";
  else extras["x-skillstate-pricing"] = "known";
  return extras;
}

async function writeChunk(res: ServerResponse, chunk: Uint8Array | string): Promise<void> {
  if (res.destroyed || res.writableEnded) return;
  if (!res.write(chunk)) await once(res, "drain");
}

export interface ProxyResult {
  port: number;
  close: () => Promise<void>;
  ledger: CostLedger;
  server: Server;
}

export async function startProxy(cfg: Partial<ProxyConfig> = {}): Promise<ProxyResult> {
  const merged = { ...DEFAULT_CONFIG, ...cfg } as RuntimeConfig;
  const config = normalizeConfigValues(merged as any) as RuntimeConfig;
  const ledger = new CostLedger(config.costLedgerPath);
  const store = new SessionStore({ stateDir: config.stateDir, ttlMs: config.sessionTtlMs });
  const upstreams = [...config.upstreams].sort((a, b) => a.priority - b.priority);
  const limiters = new Map<string, RateLimiter>();
  const breakers = new Map<string, CircuitBreaker>();
  for (const upstream of upstreams) {
    limiters.set(upstream.name, new RateLimiter(upstream));
    breakers.set(upstream.name, new CircuitBreaker(upstream.name, config.circuitBreaker));
  }

  const transport = (req: IncomingMessage, body: string | undefined, estimatedTokens: number, path = "/v1/chat/completions", method = "POST") =>
    requestUpstream({
      upstreams,
      path,
      method,
      body,
      incomingHeaders: req.headers,
      estimatedTokens,
      limiters,
      breakers,
      connectTimeoutMs: config.connectTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs,
      retryMaxAttempts: config.retryMaxAttempts,
      retryAfterCapMs: config.retryAfterCapMs,
    });

  const server = createServer(async (req, res) => {
    try {
      if (config.cors) {
        setCors(res);
        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }
      }

      if (config.verbose) {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
      }

      const path = reqPath(req.url);
      const isChat = (path === "/v1/chat/completions" || path === "/v1/messages") && req.method === "POST";

      if (path === "/v1/models" && req.method === "GET") {
        try {
          const selected = await transport(req, undefined, 0, "/v1/models", "GET");
          res.statusCode = selected.response.status;
          copyUpstreamResponseHeaders(selected.response, res);
          const text = await selected.response.text();
          selected.finish();
          res.end(text);
        } catch (error) {
          if (error instanceof TransportError) {
            res.statusCode = error.status;
            res.setHeader("content-type", "application/json");
            res.end(error.body);
          } else throw error;
        }
        return;
      }

      if (path === "/health" || path === "/v1/health") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          ok: true,
          upstreams: upstreams.map(upstream => ({
            name: upstream.name,
            circuit: breakers.get(upstream.name)?.getState() ?? "unknown",
          })),
        }));
        return;
      }

      if (path === "/state" || path === "/v1/state") {
        const sidParam = new URL(req.url ?? "/state", "http://skillstate.local").searchParams.get("session");
        if (req.method === "GET") {
          if (!sidParam) {
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ sessions: store.list() }));
            return;
          }
          const sid = safeSessionId(sidParam);
          if (!sid) {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "invalid session id" }));
            return;
          }
          const session = store.get(sid);
          if (!session) {
            res.statusCode = 404;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "session not found" }));
            return;
          }
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ session: sid, step: session.step, schema: session.schema, state: session.state }));
          return;
        }
        if (req.method === "DELETE") {
          if (!sidParam) {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "missing ?session=" }));
            return;
          }
          const sid = safeSessionId(sidParam);
          if (!sid) {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "invalid session id" }));
            return;
          }
          store.delete(sid);
          res.statusCode = 204;
          res.end();
          return;
        }
      }

      if (path === "/cost" || path === "/v1/cost") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(ledger.summarize()));
        return;
      }

      if (!isChat) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          error: "skillstate-proxy serves /v1/chat/completions, /v1/messages, /v1/models, /health, /cost, /state",
        }));
        return;
      }

      let raw: string;
      try {
        raw = await readBody(req, config.maxBodyBytes);
      } catch (error: any) {
        res.statusCode = 413;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: error?.message ?? String(error) }));
        return;
      }

      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }

      let normalized: NormalizedRequest | null;
      try {
        normalized = normalizeIncoming(req.url ?? "", body);
      } catch (error) {
        if (error instanceof AnthropicCompatibilityError) {
          res.statusCode = error.statusCode;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: error.message }));
          return;
        }
        throw error;
      }
      if (!normalized) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "request must include model and messages" }));
        return;
      }

      const isAnthropic = normalized.source === "anthropic";
      const sid = getSessionId(req);

      await store.withSessionLock(sid, async () => {
        if (res.destroyed || res.writableEnded) return;

        let session = store.get(sid);
        if (!session) {
          const spec = normalized.messages.find((message: any) => message.role === "system")?.content
            ?? (typeof body.system === "string" ? body.system : "You are a helpful agent.");
          session = newSession(String(spec), config.initialState, config.schema);
          store.save(sid, session);
        }

        const { body: rewritten } = rewriteBody(normalized.raw, session);
        let requestBody = JSON.stringify(rewritten);
        const estimated = estimateTokens(requestBody);
        const wantsStream = body?.stream === true;
        const totals: MeterTotals = {
          knownUsd: 0, knownGnk: 0, knownUsdRows: 0, unknownPricing: false, usageUnavailable: false,
        };

        let selected: SelectedUpstream;
        try {
          selected = await transport(req, requestBody, estimated);
          meterTransportAttempts(ledger, totals, selected.attempts, upstreams, modelFromBody(body));
        } catch (error) {
          if (error instanceof TransportError) {
            meterTransportAttempts(ledger, totals, error.attempts, upstreams, modelFromBody(body));
            res.statusCode = error.status;
            res.setHeader("content-type", "application/json");
            setCommonHeaders(res, sid, session, "none", "invalid", [error.message], costHeaders(totals));
            res.end(error.body);
            return;
          }
          throw error;
        }

        if (selected.response.status >= 400) {
          res.statusCode = selected.response.status;
          copyUpstreamResponseHeaders(selected.response, res);
          setCommonHeaders(res, sid, session, selected.upstream.name, "invalid", [], costHeaders(totals));
          const text = await selected.response.text();
          selected.finish();
          res.end(text);
          return;
        }

        if (wantsStream) {
          const upstream = selected.upstream as UpstreamConfig;
          const observer = new OpenAIStreamObserver(config.maxResponseCaptureBytes);
          const parser = isAnthropic ? new SseParser() : null;
          const anthropic = isAnthropic ? new AnthropicStreamAdapter(modelFromBody(body), `msg_${sid}`) : null;
          const contentType = selected.response.headers.get("content-type") ?? "text/event-stream";

          res.statusCode = selected.response.status;
          copyUpstreamResponseHeaders(selected.response, res);
          res.setHeader("content-type", isAnthropic ? "text/event-stream" : contentType);
          setCommonHeaders(res, sid, session, upstream.name, "pending", [], costHeaders(totals));

          const onClose = () => {
            if (!res.writableEnded) selected.controller.abort(new Error("downstream client disconnected"));
          };
          res.once("close", onClose);

          try {
            if (!selected.response.body) throw new Error("upstream streaming response had no body");
            const reader = selected.response.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              observer.feed(value);
              if (isAnthropic && parser && anthropic) {
                for (const frame of parser.feed(value)) {
                  for (const event of anthropic.push(frame.data)) await writeChunk(res, event);
                }
              } else {
                await writeChunk(res, value);
              }
            }
            if (isAnthropic && parser && anthropic) {
              for (const frame of parser.end()) {
                for (const event of anthropic.push(frame.data)) await writeChunk(res, event);
              }
              for (const event of anthropic.push("[DONE]")) await writeChunk(res, event);
            }

            const observed = observer.result();
            const synthetic = JSON.stringify({
              model: modelFromBody(body),
              usage: { prompt_tokens: observed.inputTokens, completion_tokens: observed.outputTokens },
            });
            if (observed.inputTokens || observed.outputTokens) meterGeneration(ledger, totals, upstream, modelFromBody(body), synthetic, "stream");
            else totals.usageUnavailable = true;

            const transition = evaluateTransition(session, observed.content, observed.toolCalls, config);
            if (transition.committed) store.save(sid, session);
            if (config.verbose && transition.status === "invalid") {
              console.warn(`[skillstate] streamed transition invalid sid=${sid}: ${transition.errors.join("; ")}`);
            }
            res.end();
          } catch (error: any) {
            if (!res.headersSent) {
              res.statusCode = 502;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ error: error?.message ?? String(error) }));
            } else if (!res.writableEnded) {
              res.destroy(error instanceof Error ? error : undefined);
            }
          } finally {
            res.removeListener("close", onClose);
            selected.finish();
          }
          return;
        }

        let finalSelected = selected;
        let finalText = await selected.response.text();
        selected.finish();
        let finalJson: any;
        try { finalJson = JSON.parse(finalText); }
        catch {
          res.statusCode = selected.response.status;
          copyUpstreamResponseHeaders(selected.response, res);
          setCommonHeaders(res, sid, session, selected.upstream.name, "invalid", ["upstream response was not JSON"], costHeaders(totals));
          res.end(finalText);
          return;
        }

        let retriesUsed = 0;
        let toolCalls = cleanToolCalls(finalJson);
        let content = typeof finalJson?.choices?.[0]?.message?.content === "string"
          ? finalJson.choices[0].message.content
          : "";
        let transition = evaluateTransition(structuredClone(session), content, toolCalls, config);
        meterGeneration(ledger, totals, selected.upstream as UpstreamConfig, modelFromBody(body, finalJson?.model), finalText, "generation");

        while (toolCalls.length === 0 && transition.status === "invalid" && retriesUsed < config.maxRetries) {
          requestBody = correctionRequest(requestBody, transition.errors);
          let retrySelected: SelectedUpstream;
          try {
            retrySelected = await transport(req, requestBody, estimateTokens(requestBody));
            meterTransportAttempts(ledger, totals, retrySelected.attempts, upstreams, modelFromBody(body, finalJson?.model));
          } catch (error) {
            if (error instanceof TransportError) {
              meterTransportAttempts(ledger, totals, error.attempts, upstreams, modelFromBody(body, finalJson?.model));
              break;
            }
            throw error;
          }
          if (retrySelected.response.status >= 400) {
            retrySelected.finish();
            break;
          }
          const retryText = await retrySelected.response.text();
          retrySelected.finish();
          let retryJson: any;
          try { retryJson = JSON.parse(retryText); }
          catch { break; }

          retriesUsed += 1;
          finalSelected = retrySelected;
          finalText = retryText;
          finalJson = retryJson;
          toolCalls = cleanToolCalls(finalJson);
          content = typeof finalJson?.choices?.[0]?.message?.content === "string"
            ? finalJson.choices[0].message.content
            : "";
          transition = evaluateTransition(structuredClone(session), content, toolCalls, config);
          meterGeneration(ledger, totals, retrySelected.upstream as UpstreamConfig, modelFromBody(body, finalJson?.model), retryText, "rollback-retry");
        }

        transition = evaluateTransition(session, content, toolCalls, config);
        if (transition.committed) store.save(sid, session);

        let outputJson = finalJson;
        if (isAnthropic) outputJson = denormalizeResponse(normalized, finalJson);

        res.statusCode = finalSelected.response.status;
        copyUpstreamResponseHeaders(finalSelected.response, res);
        res.setHeader("content-type", "application/json");
        const extras = costHeaders(totals);
        if (retriesUsed > 0) extras["x-skillstate-retries"] = String(retriesUsed);
        if (transition.action) extras["x-skillstate-action"] = transition.action.slice(0, 200);
        setCommonHeaders(res, sid, session, finalSelected.upstream.name, transition.status, transition.errors, extras);

        if (config.verbose) {
          console.log(`[${new Date().toISOString()}] ${sid} step=${session.step} model=${modelFromBody(body, finalJson?.model)} upstream=${finalSelected.upstream.name} transition=${transition.status}${retriesUsed ? ` rollback_retries=${retriesUsed}` : ""}`);
        }
        res.end(JSON.stringify(outputJson));
      });
    } catch (error: any) {
      if (res.destroyed || res.writableEnded) return;
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: error?.message ?? String(error) }));
    }
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      store.close();
      reject(error);
    };
    server.once("error", onError);
    server.listen(config.listenPort, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : config.listenPort;
      console.log(`[skillstate] proxy on http://127.0.0.1:${port}`);
      console.log(`[skillstate] upstreams: ${upstreams.map(u => `${u.name}@${u.url}${u.tpm ? ` tpm=${u.tpm}` : ""}${u.rpm ? ` rpm=${u.rpm}` : ""}${u.currency ? ` currency=${u.currency}` : ""}`).join(", ")}`);
      console.log(`[skillstate] state dir: ${config.stateDir}`);
      resolve({
        port,
        close: () => new Promise<void>(closeResolve => {
          store.close();
          if (!server.listening) {
            closeResolve();
            return;
          }
          server.close(() => closeResolve());
          server.closeIdleConnections?.();
        }),
        ledger,
        server,
      });
    });
  });
}
