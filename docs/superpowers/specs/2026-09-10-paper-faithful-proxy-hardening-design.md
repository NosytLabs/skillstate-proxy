# Paper-Faithful Proxy Hardening Design

**Date:** 2026-09-10
**Status:** Design approved; written-spec review gate before implementation
**Target:** `hardening/paper-faithful-proxy`

## Context

`skillstate-proxy` adapts ordinary OpenAI/Anthropic-style agent traffic to the SKILL.state execution model from Badhe, Tiwari, and Chung, *SKILL.state: Scalable Long-Horizon Agent Skills* (arXiv:2608.26263v3, accepted at EMNLP 2026).

The current `0.1.2` source has green CI but several externally advertised behaviors are only partially implemented: SSE is buffered, Anthropic translation is text-only, browser clients cannot read the session headers they need, failover and metering under-count some attempts, session state is process-global, and zero-schema mode does not enforce a hard state bound.

This hardening pass makes the runtime faithful to the paper where the paper defines semantics and uses production reverse-proxy practices from Headroom plus current provider SDK/API contracts where the paper is transport-agnostic.

### Primary references

- SKILL.state paper v3: https://arxiv.org/abs/2608.26263
- Exact SKILL.state prompt: Appendix A.4 of the paper
- Headroom proxy docs: https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/proxy.mdx
- Headroom Anthropic conversion docs: https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/anthropic-sdk.mdx
- OpenAI Chat Completions API: https://developers.openai.com/api/reference/resources/chat
- Anthropic TypeScript SDK Messages types: https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts
- Node.js HTTP / Undici streaming behavior: https://github.com/nodejs/node/tree/main/deps/undici

## Research constraints that become runtime requirements

The paper is explicit about the execution contract:

1. Every decision step sees only `(P, Σ_t, O_t)`: immutable procedural specification, current structured state, and latest observation.
2. Previous observations, actions, and reasoning traces are not replayed as history.
3. The model proposes `(R_t, ΔΣ_t, a_t)`; only a validated `ΔΣ_t` is merged into persistent state.
4. Merge semantics are dictionary merge with `null` deletion.
5. The schema is authored once per domain. The paper's InterCode CTF evaluation reuses one static five-field schema for all 100 tasks.
6. Invalid structured output must not corrupt persistent state; malformed patches trigger rollback-retry.
7. The bounded-prompt claim is with respect to execution horizon `T`. The runtime must not let state grow without a configured hard bound while still calling itself paper-faithful.
8. Tool use is not an edge case: the public evaluations include InterCode terminal actions and Sierra tau-Bench database/tool interactions.
9. The paper's small/open-weight failure taxonomy makes state overwrite/deletion, schema/type mistakes, and JSON formatting first-class validation cases.
10. The paper explicitly calls out limits: unknown/dynamic schemas, deferred-relevance observations that were never committed, trajectory-defined objectives such as audit/provenance, and concurrent multi-agent writes.

## Goals

The hardened proxy must:

- remain a Node.js 20+ TypeScript package with zero runtime npm dependencies;
- preserve Appendix A.4 SKILL.state prompt semantics for normal state transitions;
- make state mutation transactional: parse -> validate -> size/type/schema check -> merge -> atomically persist;
- support long-running OpenAI-compatible native tool loops, including parallel tool calls/results;
- provide correct Anthropic Messages translation for supported text and custom-tool flows, including streaming;
- deliver true incremental SSE instead of buffering a stream to completion;
- isolate sessions per proxy instance and serialize mutations per session;
- perform bounded, observable retry/failover before downstream response bytes are committed;
- count every actual upstream attempt in rate/cost accounting when usage data exists;
- preserve safe end-to-end headers and strip hop-by-hop/internal proxy headers;
- keep management and proxy traffic loopback-first;
- make every public documentation claim correspond to an automated or explicitly optional live test.

## Non-goals

This change does not turn the proxy into a full agent executor, general memory system, or multi-agent conflict-resolution runtime. It does not execute client tools itself. It does not promise lossless historical recall, multimodal fidelity, or a dynamically discovered state schema. It does not reproduce Headroom's compression, tool-search, dashboard, model router, or MCP features.

The project may compose with Headroom, but SKILL.state and Headroom solve different context-growth problems.

## Architecture

The current `src/proxy.ts` combines transport, protocol conversion, session persistence, retry/failover, state mutation, cost metering, and HTTP routing. The hardening pass separates those boundaries while preserving the public `startProxy()` entry point.

### Proposed source boundaries

- `src/proxy.ts` — HTTP route orchestration only: classify route, acquire session turn, call adapters/transport, finalize response.
- `src/transport.ts` — upstream URL construction, request headers, bounded retries, failover, client-abort propagation, non-stream and streaming transport.
- `src/sse.ts` — incremental SSE framing/parser helpers and bounded capture used for state/usage extraction.
- `src/session-store.ts` — per-proxy in-memory cache, TTL, per-session serialization, load/validate, atomic temp-file + rename persistence, delete/list.
- `src/headers.ts` — end-to-end header allow/strip rules, CORS and exposed response headers.
- `src/config.ts` — path expansion, CLI/config/env validation, precedence helpers.
- `src/anthropic.ts` — Anthropic Messages <-> OpenAI Chat adapter for supported text/tools, including streaming event translation.
- `src/state.ts` — paper semantics only: prompt construction, transition parsing, validation, merge, state-size guard.
- `src/pricing.ts` / `src/cost-ledger.ts` — explicit known/unknown pricing and per-attempt aggregation.

No runtime dependency is added. Node 20+ stdlib is sufficient for HTTP, fetch/Undici streams, crypto session IDs, filesystem persistence, and SSE parsing.

### Public configuration additions

`ProxyConfig` gains:

```ts
export type StateValueKind = "string" | "number" | "boolean" | "array" | "object";

export interface ProxyConfig {
  // existing fields remain unless explicitly deprecated below
  maxStateBytes?: number;             // default 65_536
  maxPatchBytes?: number;             // default 32_768
  maxResponseCaptureBytes?: number;   // default 2_097_152
  stateTypes?: Record<string, StateValueKind>;
  connectTimeoutMs?: number;          // default 10_000
  requestTimeoutMs?: number;          // default 300_000; applies to whole stream
  retryMaxAttempts?: number;          // default 3 total transport attempts per upstream
  retryAfterCapMs?: number;           // default 5_000
}
```

`UpstreamConfig` gains:

```ts
export interface UpstreamConfig {
  // existing fields remain
  headers?: Record<string, string>;
  pricing?:
    | { mode: "local-zero" }
    | { mode: "usd"; inputPerMillion: number; outputPerMillion: number };
}
```

All new numeric values must be finite and non-negative; byte limits and timeouts must be positive. `retryMaxAttempts` must be an integer >= 1.

## State and transition semantics

### Paper format

For non-tool final responses, the proxy persists state only when it can validate the paper format:

```json
{
  "state_patch": { "key": "value", "old_key": null },
  "action": "exact action"
}
```

The containing JSON object must have exactly `state_patch` and `action`. `state_patch` must be a plain JSON object and `action` must be a string. Legacy formats remain parseable in the exported library helper for compatibility, but the proxy does not mutate persistent state from a legacy/non-paper response.

### Transactional validation

A proposed transition is validated against a cloned candidate before the live session object changes. Validation covers:

- exact paper envelope for normal final responses;
- JSON-serializable patch values;
- schema membership in strict mode;
- top-level value kinds defined by `stateTypes`;
- otherwise, top-level value kinds inferred from non-null keys in `initialState`;
- `null` as deletion regardless of prior value kind;
- maximum patch bytes;
- maximum merged state bytes.

Explicit `stateTypes` overrides inferred kinds. A field with no explicit/inferred kind is schema-checked but type-permissive.

If validation fails, the same logical step is rollback-retried up to `maxRetries`. Failed attempts do not increment the session step and cannot mutate state. If retries are exhausted, the final upstream response is returned, state remains unchanged, and the transition failure is observable.

### Schema modes and boundedness

Paper-faithful mode requires a fixed domain schema.

Compatibility behavior remains available:

- if `schema` is provided and non-empty, it is strict;
- if `schema` is omitted/empty but `initialState` has keys, those initial top-level keys become the fixed schema;
- if both are empty, the proxy enters explicit compatibility mode rather than claiming paper-faithful schema semantics.

Both modes enforce `maxStateBytes`, so state cannot grow without a constant byte bound as `T` increases. Compatibility mode is documented as semantically weaker because arbitrary top-level keys can churn within that byte cap.

Default limits:

- `maxStateBytes = 65_536`
- `maxPatchBytes = 32_768`
- `maxBodyBytes = 1_048_576` (existing)
- `maxResponseCaptureBytes = 2_097_152`

A size violation rejects the transition; semantic state is never silently truncated.

## Tool-call execution extension

The paper defines `a_t` abstractly; HTTP SDKs represent actions as native tool calls. The proxy preserves native tool semantics rather than forcing every action into text.

### OpenAI client flow

Client tool definitions and `tool_choice` pass through unchanged to an OpenAI-compatible upstream.

If an upstream response contains native `tool_calls`:

- the tool calls are returned to the client unchanged;
- any valid paper-format state patch present in assistant text is applied;
- when no state patch accompanies the native tool call, the turn is recorded as a native-tool no-op transition: the state does not change, but the logical step advances once because an action was selected;
- the next request's latest observation includes the immediately preceding assistant tool calls plus all contiguous tool-result messages, preserving parallel call IDs and results without replaying older history.

This is a documented transport extension to the paper. Semantic state should be updated on the following tool-result step if the model did not project state before issuing the tool call.

### Multiple/parallel tool results

`O_t` includes the whole newest tool-result batch, not only the final `role: "tool"` message. The immediately preceding assistant tool-call record is included in that serialized observation so IDs and results remain paired.

The request remains bounded by `maxBodyBytes`; sibling results are never silently dropped.

## Anthropic Messages adapter

Anthropic support is a protocol-conversion boundary, not string flattening.

Supported request conversion:

- top-level `system` string and text-only system block arrays -> OpenAI system message text;
- Anthropic text blocks -> OpenAI message text;
- custom `tools: [{name, description, input_schema}]` -> OpenAI function tools;
- Anthropic `tool_choice.type = auto` -> OpenAI `auto`;
- Anthropic `tool_choice.type = any` -> OpenAI `required`;
- Anthropic `tool_choice.type = tool` -> OpenAI `{type:"function", function:{name}}`;
- Anthropic `tool_choice.type = none` -> OpenAI `none`;
- `disable_parallel_tool_use: true` -> `parallel_tool_calls: false`;
- assistant `tool_use` blocks -> OpenAI assistant `tool_calls`;
- user `tool_result` blocks -> OpenAI `role: "tool"` messages with matching call IDs;
- mixed text + tool blocks retain their text and tool-call information without dropping either.

Supported response conversion:

- OpenAI assistant text -> Anthropic `text` block;
- OpenAI function `tool_calls` -> Anthropic `tool_use` blocks;
- OpenAI `finish_reason: "tool_calls"` -> Anthropic `stop_reason: "tool_use"`;
- OpenAI `finish_reason: "length"` -> Anthropic `stop_reason: "max_tokens"`;
- normal stop -> Anthropic `stop_reason: "end_turn"`;
- usage -> Anthropic input/output token fields when present.

Unknown or unsupported Anthropic content-block types produce an explicit 400 compatibility error. They are never silently flattened to empty text.

## Streaming contract

### OpenAI-compatible client -> OpenAI-compatible upstream

Streaming is byte-faithful for the upstream SSE payload. `transport.ts` must never call `Response.text()` for `stream: true`.

The transport:

1. creates its own `AbortController` and a whole-request timeout so the timeout remains active after response headers arrive;
2. obtains upstream status/headers;
3. makes retry/failover decisions before committing downstream headers;
4. streams body chunks to the client immediately with backpressure;
5. feeds the same chunks into a bounded incremental SSE observer for text/tool/usage/state extraction;
6. aborts the upstream request when the downstream client disconnects;
7. finalizes state and ledger after the stream ends.

The regression test proves the client receives the first SSE chunk before the mock upstream sends its final chunk.

### Anthropic client -> OpenAI-compatible upstream

The proxy incrementally translates OpenAI ChatCompletion chunks into Anthropic Messages SSE. It emits `message_start`, content-block start/delta/stop events, `message_delta`, and `message_stop`, supporting both text deltas and streamed function arguments/tool calls.

### Streaming retry rule

After any downstream body bytes are committed, the proxy never replays or fails over that request. Replaying can duplicate generated actions/tool calls and corrupt protocol state.

Rollback-retry for a missing state patch is therefore transparent only for non-streaming responses. Streaming performs best-effort state projection after completion. A missing/invalid streamed patch leaves state unchanged and records the transition status for later inspection/logging.

## Session store and concurrency

The module-global session map is replaced by a `SessionStore` owned by each `startProxy()` instance.

`SessionStore`:

- validates session IDs;
- maintains TTL and list/delete behavior;
- validates a loaded session file's shape before trusting it;
- persists atomically through same-directory temporary file + rename;
- serializes logical turns for one session so overlapping requests cannot interleave reads or lose updates;
- allows different sessions to proceed concurrently;
- cleans timers on proxy close.

The on-disk session remains restart persistence.

### Session identity

A valid explicit `x-skillstate-session` is authoritative. If it is absent, the proxy creates a cryptographically random session ID and returns it in `x-skillstate-session`.

The old deterministic fallback derived only from `(system prompt, model)` is removed because separate jobs with the same prompt/model can collide. Documentation shows long-horizon clients echoing the returned session ID on subsequent calls via their SDK's extra-header mechanism.

## Upstream transport, retry, failover, and rate limits

`transport.ts` owns all upstream-attempt policy.

### Header timing

No downstream status/body bytes are committed until an upstream returns a non-retry/failover status. This is the safe failover boundary.

### Timeouts

- `connectTimeoutMs = 10_000` limits time to usable upstream response headers.
- `requestTimeoutMs = 300_000` limits the complete request/stream through a proxy-owned abort controller.

The implementation must not rely on `AbortSignal.timeout()` alone for the full streaming lifetime because Node/Undici can detach the original fetch abort listener once response headers resolve.

### Local limiter

A locally rate-limited upstream is skipped so the next configured upstream can be attempted. A request is rejected with 429 only when no configured upstream can accept it.

An accepted attempt is recorded in RPM/TPM accounting before it is sent, not only after success.

### Retryable failures

Before response commit, retry/failover applies to connection/network failure, 408, 429, and 5xx.

Each upstream gets at most `retryMaxAttempts = 3` total transport attempts. `Retry-After` is honored only when parseable and <= `retryAfterCapMs = 5_000`; otherwise exponential backoff with jitter is capped at the same value.

401/403 are terminal for that upstream but may fail over to another configured upstream with separate credentials. They are never rewritten into success.

### No retries after commit

A mid-stream disconnect is surfaced as a stream failure and recorded. It is not replayed on another provider once output/tool-call bytes may have reached the client.

## Header and CORS contract

The proxy preserves safe end-to-end request headers while stripping:

- `host` and `content-length`, which Node recalculates;
- hop-by-hop headers: `connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`, plus headers named by `Connection` tokens;
- `x-skillstate-*` internal control/observability headers before external forwarding, except the session header which is consumed locally and is never forwarded upstream.

Credential precedence is exact:

1. copy safe inbound end-to-end headers;
2. if `upstream.apiKey` is configured, replace `Authorization` with that bearer token;
3. apply `upstream.headers` last as explicit operator overrides.

Verbose logs and ledger rows never include authorization values or configured secret headers.

CORS remains enabled by default for the loopback listener and includes `Access-Control-Expose-Headers` for public SKILL.state response headers: session, step, state keys, upstream, transition status, retries, cost status, USD/GNK cost when known, and validation warnings when available before response commit.

## Observability and cost accounting

Every upstream attempt is represented internally with upstream name, attempt number, status/failure class, model, usage when provided, pricing status, known cost, and whether it was a transport retry or rollback-retry.

A client request's `x-skillstate-cost-usd` is the sum of known-cost model generations for that logical turn, including rollback-retries. Transport failures with no reported usage contribute zero tokens/cost but remain observable as attempts.

Unknown hosted models are not treated as free. Pricing resolution is:

1. `upstream.pricing.mode = "local-zero"` -> known zero cost;
2. `upstream.pricing.mode = "usd"` -> use the configured rates;
3. known model in the bundled dated table -> use bundled estimate;
4. otherwise -> pricing status `unknown`, omit numeric cost header, retain token usage.

The public pricing helper may return `null` for unknown prices in the next release; this pre-1.0 signature change is documented in release notes.

## CLI and configuration

Configuration precedence is exactly `defaults < config file < environment < CLI`.

Hardening requirements:

- validate numeric flags and required flag values;
- distinguish optional auto-discovery of `./skillstate.json` from an explicitly requested missing `--config` file;
- catch malformed `SKILLSTATE_INITIAL_STATE` and print a concise configuration error;
- validate upstream URLs before server start;
- expand a leading `~` in `stateDir` and `costLedgerPath`;
- remove the stale `defaultModel` example property;
- load CLI version from package metadata instead of duplicating it in source;
- surface startup/listen errors as a controlled non-zero exit;
- await server shutdown and internal cleanup before exit.

Programmatic `listenPort: 0` remains supported for tests.

`discardReasoning` remains accepted in `ProxyConfig` for source compatibility but is documented as deprecated: SKILL.state always discards reasoning from future prompts; the option never controls whether the original model response is returned to the caller.

## Public HTTP behavior

Existing routes remain:

- `POST /v1/chat/completions`
- `POST /v1/messages`
- `GET /v1/models`
- `GET /health` and `/v1/health`
- `GET|DELETE /state` and `/v1/state`
- `GET /cost` and `/v1/cost`

Management responses use JSON content type for non-204 outcomes, including errors.

`/health` returns process liveness plus an explicit `ready` boolean. `ready` is false when no upstream is currently attemptable.

`/state?session=` includes a non-secret `lastTransition` record with status (`applied`, `tool_noop`, `invalid`, or `stream_invalid`) and timestamp so post-stream validation failures can be diagnosed after headers are sent.

## Tests and user flows

Implementation is test-driven. Each defect receives a regression test that fails against `main` before the implementation change.

Required offline coverage:

1. **Paper prompt/transition** — A.4 labels/layout, exact envelope, null deletion, no mutation on invalid patch, schema/type/size rejection, retry preserves one logical step.
2. **100+ step synthetic horizon** — fixed schema and fixed-size observations keep state/prompt independent of prior-turn count; no old transcript appears.
3. **OpenAI tool loop** — native tool call -> multiple parallel tool results -> next state/action; every call ID/result survives in `O_t`.
4. **OpenAI streaming** — delayed mock upstream proves first-byte streaming; SSE bytes are unchanged; final state/usage is captured.
5. **Anthropic text + tools** — `tool_use`/`tool_result`, tool choice, mixed text/tool content, usage, stop reason.
6. **Anthropic streaming tools** — streamed OpenAI tool-call arguments produce a valid Anthropic tool-use SSE lifecycle.
7. **Session isolation** — two proxy instances with identical session IDs and different state dirs never share memory.
8. **Same-session concurrency** — two overlapping turns serialize and do not lose state updates.
9. **Failover** — local limiter, 429, 5xx, network failure, and 401/403 with alternate credentials; no failover after stream commit.
10. **Metering** — rollback retries count generations; transport retries count attempts; unknown pricing is not `$0`.
11. **CORS/header flow** — browser-readable SKILL.state headers; configured authorization precedence; hop-by-hop/internal headers do not leak.
12. **CLI/package flow** — help/version, bad/missing values, malformed env JSON, missing explicit config, tilde expansion, graceful startup failure, package contents via `npm pack --dry-run` or equivalent.
13. **Static site flow** — home, anchors, primary external links, sitemap/robots, custom 404; site copy distinguishes published npm behavior from unreleased `main` until publishing occurs.

Optional live tests remain gated by environment variables and exercise at least one real OpenAI-compatible upstream with a three-step state loop. A separate optional live tool-call test is added when a provider/model supporting function tools is configured.

Vitest's long timeout is scoped only to opt-in live tests; offline tests use short deterministic timeouts.

## CI

CI remains Node 20 + 22 and runs clean install, TypeScript build, offline tests, package smoke checks, and static docs checks. Live provider tests remain opt-in because credentials are required.

## Documentation and site truthfulness

README and Pages are changed only after the behavior they describe is covered by tests.

The docs explicitly state:

- paper-faithful mode requires a fixed domain schema;
- compatibility mode is byte-bounded but semantically weaker;
- the proxy does not preserve full historical chat;
- native tool calls are supported, with state projection possibly occurring on the following tool-result step when the model emits no state patch alongside the tool call;
- streaming is truly incremental, but post-stream invalid-state rollback cannot be transparently replayed after bytes are delivered;
- explicit session IDs are required to safely distinguish simultaneous jobs;
- unknown pricing is unknown rather than zero;
- SKILL.state targets long execution history; very large individual tool payloads may benefit from an orthogonal compressor such as Headroom;
- the paper's stated limitations remain limitations here.

No benchmark value is presented as a universal guarantee. Repo-measured values remain labeled by provider/model/date; paper values remain attributed to the paper.

## Compatibility and release handling

The public package is currently `0.1.2`. Source changes are developed on the hardening branch without claiming npm already contains them.

Where practical, existing `startProxy`, route names, environment variables, and public exports remain. The pricing helper's unknown-price return may change from numeric zero to `null`; this is an intentional correctness change and must be highlighted in the next release notes.

The website identifies the currently published npm version separately from unreleased source until a new package is actually published.

## Acceptance criteria

The hardening branch is ready to merge only when all of the following hold:

- clean build and full offline suite pass on Node 20 and 22;
- zero runtime npm dependencies remain;
- same-protocol OpenAI SSE delivers the first chunk before upstream completion and preserves payload bytes;
- OpenAI and Anthropic native tool loops work in non-streaming and supported streaming paths;
- invalid state patches cannot mutate disk or memory state;
- fixed-schema 100+ step tests do not replay history and remain bounded in execution-horizon growth;
- session isolation and same-session serialization pass;
- failover works before response commit and never replays a committed stream;
- every model generation/retry with reported usage is included in metering;
- browser JavaScript can read the SKILL.state response headers;
- CLI/package/static-site user flows pass;
- README and Pages do not advertise behavior absent from the tested implementation;
- latest branch CI is green before any completion claim.
