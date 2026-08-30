/**
 * skillstate-proxy — OpenAI-compatible proxy enforcing SKILL.state discipline.
 * Now merged with headroom infra: circuit breaker, rate limiter, cost ledger,
 * pricing (USD+GNK), multi-upstream fallback, and model-agnostic (OpenAI/Anthropic).
 *
 * Based on:
 *  - SKILL.state (arXiv:2608.26263) — https://arxiv.org/abs/2608.26263
 *  - headroom (loonie) — rate limiter, circuit breaker, cost ledger, SSE passthrough
 */

import { createServer, IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { newSession, buildStepPrompt, extractDelta, applyDelta, type StateSession } from "./state.js";
import { estimateTokens, extractUsage } from "./token-estimate.js";
import { CostLedger } from "./cost-ledger.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { RateLimiter } from "./rate-limiter.js";
import { costFor, gonkaCost, priceFor } from "./pricing.js";
import { normalizeIncoming, denormalizeResponse } from "./anthropic.js";

export interface UpstreamConfig {
  name: string;
  url: string;
  apiKey?: string;
  priority: number;
  tpm?: number;
  rpm?: number;
  openrouter?: boolean;
}

export interface ProxyConfig {
  listenPort: number;
  upstreams: UpstreamConfig[];
  stateDir: string;
  schema: string[];
  initialState: Record<string, unknown>;
  discardReasoning: boolean;
  costLedgerPath: string;
  openrouterZdr?: boolean;
}

export const DEFAULT_CONFIG: ProxyConfig = {
  listenPort: 8789,
  upstreams: [{ name: "tokenrouter", url: "https://api.tokenrouter.com/v1", priority: 0 }],
  stateDir: join(process.env.HOME ?? "/tmp", ".skillstate/state"),
  schema: [],
  initialState: {},
  discardReasoning: true,
  costLedgerPath: join(process.env.HOME ?? "/tmp", ".skillstate/spend.jsonl"),
  openrouterZdr: false,
};

const sessions = new Map<string, StateSession>();

function sessionFile(stateDir: string, id: string): string { return join(stateDir, `${id}.json`); }
function loadSession(stateDir: string, id: string): StateSession | null {
  if (sessions.has(id)) return sessions.get(id)!;
  const f = sessionFile(stateDir, id);
  if (existsSync(f)) {
    try { const s = JSON.parse(readFileSync(f, "utf-8")) as StateSession; sessions.set(id, s); return s; } catch {}
  }
  return null;
}
function saveSession(stateDir: string, id: string, s: StateSession): void {
  sessions.set(id, s);
  try { if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true }); writeFileSync(sessionFile(stateDir, id), JSON.stringify(s)); } catch {}
}

function getSessionId(req: IncomingMessage, body: any): string {
  const hdr = req.headers["x-skillstate-session"];
  if (typeof hdr === "string" && hdr.length) return hdr;
  const sys = body?.messages?.find((m: any) => m.role === "system")?.content ?? body?.system ?? "";
  const model = body?.model ?? "";
  return createHash("sha256").update(String(sys) + "::" + model).digest("hex").slice(0, 24);
}

async function callUpstream(upstream: UpstreamConfig, path: string, body: string, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string,string>; stream: boolean }> {
  // The upstream URL is the API root (e.g. https://openrouter.ai/api/v1 or
  // https://api.openbroker.gonka.gg/v1). The proxy path is /v1/chat/completions.
  // Strip the trailing /v1 from the upstream URL before appending the path so
  // we don't double-up (/api/v1 + /v1/chat = wrong).
  const u = new URL(upstream.url);
  const root = u.pathname.replace(/\/v1\/?$/, "");
  const target = `${u.origin}${root}${path}`;
  const isStream = /"stream"\s*:\s*true/.test(body);
  const res = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json", ...(upstream.apiKey ? { authorization: `Bearer ${upstream.apiKey}` } : {}), ...extraHeaders },
    body,
  } as any);
  // For streaming we need to handle SSE passthrough separately; for now buffer
  const headers: Record<string,string> = {};
  res.headers.forEach((v,k)=>{ if (!["content-encoding","transfer-encoding","connection"].includes(k.toLowerCase())) headers[k]=v; });
  const text = await res.text();
  return { status: res.status, body: text, headers, stream: isStream && text.includes("data:") };
}

function rewriteBody(body: any, session: StateSession): { body: any; observation: string } {
  const messages: any[] = body.messages ?? [];
  const obsMsg = [...messages].reverse().find((m) => m.role !== "system");
  const observation: string = typeof obsMsg?.content === "string" ? obsMsg.content : JSON.stringify(obsMsg?.content ?? "");
  const { system, user } = buildStepPrompt(session, observation);
  return { body: { ...body, messages: [{ role: "system", content: system }, { role: "user", content: user }] }, observation };
}

function tryParseContent(sse: string): { content: string; inTok: number; outTok: number } {
  if (sse.trim().startsWith("{")) {
    try { const j = JSON.parse(sse); return { content: j.choices?.[0]?.message?.content ?? "", inTok: j.usage?.prompt_tokens ?? 0, outTok: j.usage?.completion_tokens ?? 0 }; } catch {}
  }
  let content = "";
  for (const line of sse.split("\n")) {
    if (line.startsWith("data:")) {
      const d = line.slice(5).trim(); if (d === "[DONE]") continue;
      try { const j = JSON.parse(d); content += j.choices?.[0]?.delta?.content ?? ""; } catch {}
    }
  }
  return { content, inTok: 0, outTok: 0 };
}

export async function startProxy(cfg: Partial<ProxyConfig> = {}): Promise<{ port: number; close: () => void; ledger: CostLedger }> {
  const config: ProxyConfig = { ...DEFAULT_CONFIG, ...cfg };
  if (!existsSync(config.stateDir)) mkdirSync(config.stateDir, { recursive: true });
  const ledger = new CostLedger(config.costLedgerPath);
  const limiters = new Map<string, RateLimiter>();
  const breakers = new Map<string, CircuitBreaker>();
  for (const u of config.upstreams) { limiters.set(u.name, new RateLimiter(u)); breakers.set(u.name, new CircuitBreaker(u.name)); }
  const upstreams = [...config.upstreams].sort((a,b)=>a.priority-b.priority);

  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf-8");
      const isChat = (req.url?.startsWith("/v1/chat/completions") || req.url?.startsWith("/v1/messages")) && req.method === "POST";
      const isModels = req.url?.startsWith("/v1/models") && req.method === "GET";
      if (isModels) {
        const u = upstreams[0]; if (!u) { res.statusCode=500; res.end(JSON.stringify({error:"no upstream"})); return; }
        const url = new URL(u.url);
                const root = url.pathname.replace(/\/v1\/?$/, "");
                const target = `${url.origin}${root}/v1/models`;
                const r = await fetch(target, { headers: u.apiKey ? { authorization: `Bearer ${u.apiKey}` } : {} });
        res.statusCode=r.status; res.setHeader("content-type","application/json"); res.end(await r.text()); return;
      }
      if (!isChat) {
        // health + cost summary
        if (req.url?.startsWith("/health") || req.url?.startsWith("/v1/health")) { res.statusCode=200; res.setHeader("content-type","application/json"); res.end(JSON.stringify({ ok:true, upstreams: upstreams.map(u=>({name:u.name, circuit: breakers.get(u.name)!.getState()})) })); return; }
        if (req.url?.startsWith("/cost") || req.url?.startsWith("/v1/cost")) { const s=ledger.summarize(); res.statusCode=200; res.setHeader("content-type","application/json"); res.end(JSON.stringify(s)); return; }
        res.statusCode=404; res.setHeader("content-type","application/json"); res.end(JSON.stringify({ error: "skillstate-proxy serves /v1/chat/completions, /v1/messages, /v1/models, /health, /cost" })); return;
      }
      let body: any; try { body = JSON.parse(raw); } catch { res.statusCode=400; res.end(JSON.stringify({ error:"invalid JSON body"})); return; }
      const normalized = normalizeIncoming(req.url ?? "", body);
      const isAnthropic = normalized?.source === "anthropic";
      // Use normalized messages for session id + rewriting
      const sid = getSessionId(req, normalized?.raw ?? body);
      let session = loadSession(config.stateDir, sid);
      if (!session) {
        const spec = normalized?.messages.find(m=>m.role==="system")?.content ?? body.system ?? "You are a helpful agent.";
        session = newSession(String(spec), config.initialState, config.schema);
        saveSession(config.stateDir, sid, session);
      }
      // rewrite
      const toRewrite = normalized ? { ...normalized.raw, messages: normalized.messages } : body;
      const { body: rewritten } = rewriteBody(toRewrite, session);
      // If original was Anthropic, keep rewritten as OpenAI for upstream; we'll denormalize response back
      const upstreamBody = JSON.stringify(rewritten);
      const estimated = estimateTokens(upstreamBody);

      let lastErr: { status:number; body:string } | null = null;
      for (const u of upstreams) {
        const lim = limiters.get(u.name)!; const breaker = breakers.get(u.name)!;
        const allow = lim.check(estimated);
        if (!allow.ok) { res.statusCode=429; res.setHeader("retry-after", String(allow.retryAfter ?? 60)); res.end(JSON.stringify({ error:`rate-limited by ${u.name}; retry after ${allow.retryAfter ?? 60}s`})); return; }
        if (breaker.getState()==="open") { lastErr={status:503, body:JSON.stringify({error:`circuit[${u.name}] open`})}; continue; }
        try {
          const upstreamPath = "/v1/chat/completions";
          const upstreamRes = await callUpstream(u, upstreamPath, upstreamBody);
          if (upstreamRes.status >= 500) { breaker.recordFailure(); lastErr={status:upstreamRes.status, body: upstreamRes.body}; continue; }
          breaker.recordSuccess(); lim.record(estimated);

          if (upstreamRes.stream) {
            const parsed = tryParseContent(upstreamRes.body);
            const { delta } = extractDelta(parsed.content);
            const { warnings } = applyDelta(session, delta); saveSession(config.stateDir, sid, session);
            const usage = extractUsage(upstreamRes.body);
            const inputTokens = usage?.inputTokens ?? parsed.inTok; const outputTokens = usage?.outputTokens ?? parsed.outTok;
            const usd = costFor(body.model ?? "", inputTokens, outputTokens); const gnk = u.name.includes("gonka") ? gonkaCost(inputTokens+outputTokens).gnk : undefined;
            ledger.record({ ts: new Date().toISOString(), upstream: u.name, model: body.model ?? "", inputTokens, outputTokens, costUsd: usd, costGnk: gnk });
            res.statusCode=upstreamRes.status; res.setHeader("content-type","text/event-stream"); res.setHeader("x-skillstate-session", sid); res.setHeader("x-skillstate-step", String(session.step)); res.setHeader("x-skillstate-statekeys", Object.keys(session.state).join(",")); res.setHeader("x-skillstate-upstream", u.name); if (warnings.length) res.setHeader("x-skillstate-validation", warnings.join("|")); res.end(upstreamRes.body); return;
          }
          let upstreamJson: any; try { upstreamJson = JSON.parse(upstreamRes.body); } catch { res.statusCode=upstreamRes.status; res.setHeader("content-type","application/json"); for (const[k,v] of Object.entries(upstreamRes.headers)) res.setHeader(k,v); res.end(upstreamRes.body); return; }
          const content: string = upstreamJson.choices?.[0]?.message?.content ?? "";
          const { delta } = extractDelta(content);
          const { warnings } = applyDelta(session, delta); saveSession(config.stateDir, sid, session);
          const usage = upstreamJson.usage ?? {}; const inputTokens = usage.prompt_tokens ?? 0; const outputTokens = usage.completion_tokens ?? 0;
          const usd = costFor(body.model ?? upstreamJson.model ?? "", inputTokens, outputTokens); const gnk = u.name.includes("gonka") ? gonkaCost(inputTokens+outputTokens).gnk : undefined;
          ledger.record({ ts: new Date().toISOString(), upstream: u.name, model: body.model ?? upstreamJson.model ?? "", inputTokens, outputTokens, costUsd: usd, costGnk: gnk });

          let outJson = upstreamJson;
          if (isAnthropic && normalized) outJson = denormalizeResponse(normalized, upstreamJson);
          res.statusCode=200; res.setHeader("content-type","application/json"); res.setHeader("x-skillstate-session", sid); res.setHeader("x-skillstate-step", String(session.step)); res.setHeader("x-skillstate-statekeys", Object.keys(session.state).join(",")); res.setHeader("x-skillstate-upstream", u.name); res.setHeader("x-skillstate-cost-usd", String(usd.toFixed(6))); if (gnk) res.setHeader("x-skillstate-cost-gnk", String(gnk.toFixed(6))); if (warnings.length) res.setHeader("x-skillstate-validation", warnings.join("|"));
          res.end(JSON.stringify(outJson)); return;
        } catch (e:any) { breakers.get(u.name)!.recordFailure(); lastErr={status:502, body: JSON.stringify({ error: (e as Error).message })}; }
      }
      res.statusCode=lastErr?.status ?? 502; res.setHeader("content-type","application/json"); res.end(lastErr?.body ?? JSON.stringify({ error:"all upstreams failed"}));
    } catch (e:any) { res.statusCode=500; res.setHeader("content-type","application/json"); res.end(JSON.stringify({ error: e?.message ?? String(e) })); }
  });

  return new Promise((resolve)=>{
    server.listen(config.listenPort, "127.0.0.1", ()=>{
      // eslint-disable-next-line no-console
      console.log(`[skillstate] proxy on http://127.0.0.1:${config.listenPort}`);
      // eslint-disable-next-line no-console
      console.log(`[skillstate] upstreams: ${upstreams.map(u=>u.name+"@"+u.url+(u.tpm?` tpm=${u.tpm}`:"")+(u.rpm?` rpm=${u.rpm}`:"")).join(", ")}`);
      // eslint-disable-next-line no-console
      console.log(`[skillstate] state dir: ${config.stateDir}`);
      resolve({ port: config.listenPort, close: ()=>server.close(), ledger });
    });
  });
}
