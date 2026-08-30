/**
 * skillstate-proxy — OpenAI-compatible proxy enforcing SKILL.state discipline.
 * Rewrites every request to (P, Σ, O), validates + persists ΔΣ, discards reasoning.
 * Includes production hardening: circuit breaker, rate limiter, cost ledger,
 * multi-upstream failover, and Anthropic↔OpenAI translation.
 *
 * Based on SKILL.state (arXiv:2608.26263) — https://arxiv.org/abs/2608.26263
 */

import { createServer, IncomingMessage, Server } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newSession, buildStepPrompt, extractDelta, applyDelta, type StateSession } from "./state.js";
import { estimateTokens, extractUsage } from "./token-estimate.js";
import { CostLedger } from "./cost-ledger.js";
import { CircuitBreaker, type CircuitBreakerConfig } from "./circuit-breaker.js";
import { RateLimiter } from "./rate-limiter.js";
import { costFor, gonkaCost } from "./pricing.js";
import { normalizeIncoming, denormalizeResponse } from "./anthropic.js";

export interface UpstreamConfig {
  name: string;
  url: string;
  apiKey?: string;
  priority: number;
  tpm?: number;
  rpm?: number;
  /** Settlement currency for the cost ledger. "usd" (default) or "gnk" (Gonka). */
  currency?: "usd" | "gnk";
}

export interface ProxyConfig {
  listenPort: number;
  upstreams: UpstreamConfig[];
  stateDir: string;
  schema: string[];
  initialState: Record<string, unknown>;
  discardReasoning: boolean;
  costLedgerPath: string;
  /** Maximum rollback-retry attempts on invalid (no-paper-format) ΔΣ (default 2). */
  maxRetries?: number;
  /** Maximum request body size in bytes (default 1MB). */
  maxBodyBytes?: number;
  /** Session TTL in ms. Sessions older than this are evicted on access (default 24h). */
  sessionTtlMs?: number;
  /** Enable CORS headers for browser-based agents (default true). */
  cors?: boolean;
  /** Circuit breaker config (threshold + cooldown). */
  circuitBreaker?: CircuitBreakerConfig;
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
  maxBodyBytes: 1_048_576, // 1 MB
  sessionTtlMs: 24 * 60 * 60 * 1000, // 24 hours
  cors: true,
};

// ── Session persistence ──────────────────────────────────────────────

const sessions = new Map<string, { session: StateSession; lastAccess: number }>();

function sessionFile(stateDir: string, id: string): string {
  return join(stateDir, `${id}.json`);
}

function loadSession(stateDir: string, id: string, ttlMs: number): StateSession | null {
  const entry = sessions.get(id);
  if (entry) {
    entry.lastAccess = Date.now();
    return entry.session;
  }
  const f = sessionFile(stateDir, id);
  if (existsSync(f)) {
    try {
      const s = JSON.parse(readFileSync(f, "utf-8")) as StateSession;
      sessions.set(id, { session: s, lastAccess: Date.now() });
      return s;
    } catch {
      console.error(`[skillstate] corrupted session file: ${f}`);
    }
  }
  return null;
}

function saveSession(stateDir: string, id: string, s: StateSession): void {
  sessions.set(id, { session: s, lastAccess: Date.now() });
  try {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    writeFileSync(sessionFile(stateDir, id), JSON.stringify(s));
  } catch (err: any) {
    console.error(`[skillstate] failed to persist session ${id}: ${err?.message ?? err}`);
  }
}

function gcSessions(ttlMs: number): void {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.lastAccess > ttlMs) sessions.delete(k);
  }
}

// ── Request helpers ──────────────────────────────────────────────────

function getSessionId(req: IncomingMessage, body: any): string {
  const hdr = req.headers["x-skillstate-session"];
  if (typeof hdr === "string" && hdr.length) return hdr;
  const sys = body?.messages?.find((m: any) => m.role === "system")?.content ?? body?.system ?? "";
  const model = body?.model ?? "";
  return createHash("sha256").update(String(sys) + "::" + model).digest("hex").slice(0, 24);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw new Error(`request body exceeded ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function isStreamRequest(body: any): boolean {
  // Check parsed field, not raw string (avoids false positives inside string values)
  return body?.stream === true;
}

function rewriteBody(body: any, session: StateSession): { body: any; observation: string } {
  const messages: any[] = body.messages ?? [];
  const obsMsg = [...messages].reverse().find((m: any) => m.role !== "system");
  const observation: string = typeof obsMsg?.content === "string" ? obsMsg.content : JSON.stringify(obsMsg?.content ?? "");
  const { system, user } = buildStepPrompt(session, observation);
  // Strip top-level `system` field (Anthropic sends it separately)
  const { system: _drop, ...rest } = body;
  return {
    body: { ...rest, messages: [{ role: "system", content: system }, { role: "user", content: user }] },
    observation,
  };
}

function tryParseContent(sse: string): { content: string; inTok: number; outTok: number } {
  if (sse.trim().startsWith("{")) {
    try {
      const j = JSON.parse(sse);
      return {
        content: j.choices?.[0]?.message?.content ?? "",
        inTok: j.usage?.prompt_tokens ?? 0,
        outTok: j.usage?.completion_tokens ?? 0,
      };
    } catch { /* fall through */ }
  }
  let content = "";
  for (const line of sse.split("\n")) {
    if (line.startsWith("data:")) {
      const d = line.slice(5).trim();
      if (d === "[DONE]") continue;
      try {
        const j = JSON.parse(d);
        content += j.choices?.[0]?.delta?.content ?? "";
      } catch { /* skip malformed SSE frame */ }
    }
  }
  return { content, inTok: 0, outTok: 0 };
}

// ── Upstream call ────────────────────────────────────────────────────

interface UpstreamResult {
  status: number;
  body: string;
  headers: Record<string, string>;
  stream: boolean;
}

async function callUpstream(
  upstream: UpstreamConfig,
  path: string,
  body: string,
  isStream: boolean,
): Promise<UpstreamResult> {
  const u = new URL(upstream.url);
  const root = u.pathname.replace(/\/v1\/?$/, "");
  const target = `${u.origin}${root}${path}`;

  const res = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(upstream.apiKey ? { authorization: `Bearer ${upstream.apiKey}` } : {}),
    },
    body,
  } as any);

  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (!["content-encoding", "transfer-encoding", "connection"].includes(k.toLowerCase())) {
      headers[k] = v;
    }
  });

  const text = await res.text();
  return { status: res.status, body: text, headers, stream: isStream && text.includes("data:") };
}

// ── Set response headers (DRY) ───────────────────────────────────────

function setCommonHeaders(
  res: any,
  sid: string,
  session: StateSession,
  upstreamName: string,
  warnings: string[],
  extras: Record<string, string> = {},
): void {
  res.setHeader("x-skillstate-session", sid);
  res.setHeader("x-skillstate-step", String(session.step));
  res.setHeader("x-skillstate-statekeys", Object.keys(session.state).join(","));
  res.setHeader("x-skillstate-upstream", upstreamName);
  if (warnings.length) res.setHeader("x-skillstate-validation", warnings.join("|"));
  for (const [k, v] of Object.entries(extras)) res.setHeader(k, v);
}

// ── Proxy entry point ────────────────────────────────────────────────

export interface ProxyResult {
  port: number;
  close: () => void;
  ledger: CostLedger;
  server: Server;
}

export async function startProxy(cfg: Partial<ProxyConfig> = {}): Promise<ProxyResult> {
  const config: ProxyConfig = { ...DEFAULT_CONFIG, ...cfg };
  if (!existsSync(config.stateDir)) mkdirSync(config.stateDir, { recursive: true });

  const ledger = new CostLedger(config.costLedgerPath);
  const limiters = new Map<string, RateLimiter>();
  const breakers = new Map<string, CircuitBreaker>();

  for (const u of config.upstreams) {
    limiters.set(u.name, new RateLimiter(u));
    breakers.set(u.name, new CircuitBreaker(u.name, config.circuitBreaker));
  }

  const upstreams = [...config.upstreams].sort((a, b) => a.priority - b.priority);
  const maxBody = config.maxBodyBytes ?? 1_048_576;
  const sessionTtl = config.sessionTtlMs ?? 24 * 60 * 60 * 1000;
  const maxRetries = config.maxRetries ?? 2;

  // Periodic session GC (every 5 minutes)
  const gcTimer = setInterval(() => gcSessions(sessionTtl), 5 * 60 * 1000);
  gcTimer.unref();

  const server = createServer(async (req, res) => {
    try {
      // CORS headers
      if (config.cors) {
        res.setHeader("access-control-allow-origin", "*");
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        res.setHeader("access-control-allow-headers", "content-type, authorization, x-skillstate-session");
        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }
      }

      const isChat =
        (req.url?.startsWith("/v1/chat/completions") || req.url?.startsWith("/v1/messages")) &&
        req.method === "POST";
      const isModels = req.url?.startsWith("/v1/models") && req.method === "GET";

      // ── /v1/models ──
      if (isModels) {
        const u = upstreams[0];
        if (!u) { res.statusCode = 500; res.end(JSON.stringify({ error: "no upstream" })); return; }
        const url = new URL(u.url);
        const root = url.pathname.replace(/\/v1\/?$/, "");
        const target = `${url.origin}${root}/v1/models`;
        const r = await fetch(target, { headers: u.apiKey ? { authorization: `Bearer ${u.apiKey}` } : {} });
        res.statusCode = r.status;
        res.setHeader("content-type", "application/json");
        res.end(await r.text());
        return;
      }

      // ── /health ──
      if (req.url?.startsWith("/health") || req.url?.startsWith("/v1/health")) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          ok: true,
          upstreams: upstreams.map((u) => ({
            name: u.name,
            circuit: breakers.get(u.name)?.getState() ?? "unknown",
          })),
        }));
        return;
      }

      // ── /cost ──
      if (req.url?.startsWith("/cost") || req.url?.startsWith("/v1/cost")) {
        const s = ledger.summarize();
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(s));
        return;
      }

      // ── 404 ──
      if (!isChat) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          error: "skillstate-proxy serves /v1/chat/completions, /v1/messages, /v1/models, /health, /cost",
        }));
        return;
      }

      // ── Parse body ──
      let raw: string;
      try {
        raw = await readBody(req, maxBody);
      } catch (err: any) {
        res.statusCode = 413;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: err.message }));
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

      // ── Normalize Anthropic → OpenAI ──
      const normalized = normalizeIncoming(req.url ?? "", body);
      const isAnthropic = normalized?.source === "anthropic";
      const sid = getSessionId(req, normalized?.raw ?? body);

      let session = loadSession(config.stateDir, sid, sessionTtl);
      if (!session) {
        const spec = normalized?.messages.find((m: any) => m.role === "system")?.content ?? body.system ?? "You are a helpful agent.";
        session = newSession(String(spec), config.initialState, config.schema);
        saveSession(config.stateDir, sid, session);
      }

      // ── Rewrite to (P, Σ, O) ──
      const toRewrite = normalized ? { ...normalized.raw, messages: normalized.messages } : body;
      const { body: rewritten } = rewriteBody(toRewrite, session);
      const upstreamBody = JSON.stringify(rewritten);
      const estimated = estimateTokens(upstreamBody);
      const stream = isStreamRequest(body);

      // ── Upstream failover loop ──
      let lastErr: { status: number; body: string } | null = null;

      for (const u of upstreams) {
        const lim = limiters.get(u.name)!;
        const breaker = breakers.get(u.name)!;

        const allow = lim.check(estimated);
        if (!allow.ok) {
          res.statusCode = 429;
          res.setHeader("retry-after", String(allow.retryAfter ?? 60));
          res.end(JSON.stringify({ error: `rate-limited by ${u.name}; retry after ${allow.retryAfter ?? 60}s` }));
          return;
        }

        if (breaker.getState() === "open") {
          lastErr = { status: 503, body: JSON.stringify({ error: `circuit[${u.name}] open` }) };
          continue;
        }

        try {
          const upstreamRes = await callUpstream(u, "/v1/chat/completions", upstreamBody, stream);

          if (upstreamRes.status >= 500) {
            breaker.recordFailure();
            lastErr = { status: upstreamRes.status, body: upstreamRes.body };
            continue;
          }

          breaker.recordSuccess();
          lim.record(estimated);

          // ── Streaming response (buffered for state extraction) ──
          if (upstreamRes.stream) {
            const parsed = tryParseContent(upstreamRes.body);
            const { delta } = extractDelta(parsed.content);
            const { warnings } = applyDelta(session, delta);
            saveSession(config.stateDir, sid, session);

            const usage = extractUsage(upstreamRes.body);
            const inputTokens = usage?.inputTokens ?? parsed.inTok;
            const outputTokens = usage?.outputTokens ?? parsed.outTok;
            const usd = costFor(body.model ?? "", inputTokens, outputTokens);
            const gnk = u.currency === "gnk" ? gonkaCost(inputTokens + outputTokens).gnk : undefined;
            ledger.record({ ts: new Date().toISOString(), upstream: u.name, model: body.model ?? "", inputTokens, outputTokens, costUsd: usd, costGnk: gnk });

            res.statusCode = upstreamRes.status;
            res.setHeader("content-type", "text/event-stream");
            setCommonHeaders(res, sid, session, u.name, warnings);
            res.end(upstreamRes.body);
            return;
          }

          // ── Non-streaming response ──
          let upstreamJson: any;
          try {
            upstreamJson = JSON.parse(upstreamRes.body);
          } catch {
            res.statusCode = upstreamRes.status;
            res.setHeader("content-type", "application/json");
            for (const [k, v] of Object.entries(upstreamRes.headers)) res.setHeader(k, v);
            res.end(upstreamRes.body);
            return;
          }

          // ── Rollback-retry (paper §"invalid patch triggers rollback-retry") ──
          let attempts = 0;
          let retriesUsed = 0;
          let lastRetriedBody = upstreamBody;
          let content: string = upstreamJson.choices?.[0]?.message?.content ?? "";
          let ex = extractDelta(content);
          let delta = ex.delta;
          let modelRawJson = upstreamJson;

          while (ex.format !== "paper" && attempts < maxRetries && content.length > 0) {
            try {
              const parsed = JSON.parse(lastRetriedBody);
              const um = parsed?.messages?.[1];
              if (um && typeof um.content === "string") {
                um.content += "\n\n[CORRECTION: Your previous reply did NOT include a structured ```json block with a `state_patch` key. Reply again with ONLY: (1) brief reasoning, (2) a single ```json block containing {\"state_patch\": {…}, \"action\": \"…\"}.]";
              }
              lastRetriedBody = JSON.stringify(parsed);
            } catch {
              break;
            }

            const retryRes = await callUpstream(u, "/v1/chat/completions", lastRetriedBody, false);
            if (retryRes.status >= 500) {
              breaker.recordFailure();
              break;
            }
            breaker.recordSuccess();

            try {
              modelRawJson = JSON.parse(retryRes.body);
            } catch {
              break;
            }
            content = modelRawJson.choices?.[0]?.message?.content ?? "";
            ex = extractDelta(content);
            delta = ex.delta;
            attempts++;
            retriesUsed++;
            if (ex.format === "paper") break;
          }

          const { warnings } = applyDelta(session, delta);
          saveSession(config.stateDir, sid, session);

          const usage = modelRawJson.usage ?? {};
          const inputTokens = usage.prompt_tokens ?? 0;
          const outputTokens = usage.completion_tokens ?? 0;
          const usd = costFor(body.model ?? modelRawJson.model ?? "", inputTokens, outputTokens);
          const gnk = u.currency === "gnk" ? gonkaCost(inputTokens + outputTokens).gnk : undefined;
          ledger.record({ ts: new Date().toISOString(), upstream: u.name, model: body.model ?? modelRawJson.model ?? "", inputTokens, outputTokens, costUsd: usd, costGnk: gnk });

          let outJson = modelRawJson;
          if (isAnthropic && normalized) outJson = denormalizeResponse(normalized, modelRawJson);

          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          setCommonHeaders(res, sid, session, u.name, warnings, {
            "x-skillstate-cost-usd": usd.toFixed(6),
            ...(gnk ? { "x-skillstate-cost-gnk": gnk.toFixed(6) } : {}),
            ...(retriesUsed > 0 ? { "x-skillstate-retries": String(retriesUsed) } : {}),
            ...(ex.action ? { "x-skillstate-action": ex.action.slice(0, 200) } : {}),
          });
          res.end(JSON.stringify(outJson));
          return;
        } catch (e: any) {
          breaker.recordFailure();
          lastErr = { status: 502, body: JSON.stringify({ error: e?.message ?? String(e) }) };
        }
      }

      // All upstreams failed
      res.statusCode = lastErr?.status ?? 502;
      res.setHeader("content-type", "application/json");
      res.end(lastErr?.body ?? JSON.stringify({ error: "all upstreams failed" }));
    } catch (e: any) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: e?.message ?? String(e) }));
    }
  });

  return new Promise((resolve) => {
    server.listen(config.listenPort, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : config.listenPort;
      console.log(`[skillstate] proxy on http://127.0.0.1:${port}`);
      console.log(`[skillstate] upstreams: ${upstreams.map((u) => u.name + "@" + u.url + (u.tpm ? ` tpm=${u.tpm}` : "") + (u.rpm ? ` rpm=${u.rpm}` : "") + (u.currency ? ` currency=${u.currency}` : "")).join(", ")}`);
      console.log(`[skillstate] state dir: ${config.stateDir}`);
      resolve({
        port,
        close: () => {
          clearInterval(gcTimer);
          server.close();
        },
        ledger,
        server,
      });
    });
  });
}
