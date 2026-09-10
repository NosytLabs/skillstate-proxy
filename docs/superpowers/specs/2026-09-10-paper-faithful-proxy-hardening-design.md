# Paper-Faithful Proxy Hardening Design

**Date:** 2026-09-10
**Status:** Approved scope; implementation contract pending final review
**Target:** `hardening/paper-faithful-proxy`

## Context

`skillstate-proxy` is intended to adapt ordinary OpenAI/Anthropic-style agent traffic to the SKILL.state execution model from Badhe, Tiwari, and Chung, *SKILL.state: Scalable Long-Horizon Agent Skills* (arXiv:2608.26263v3, accepted at EMNLP 2026).

The current `0.1.2` source has a solid core and green CI, but several externally advertised behaviors are only partially implemented: SSE is buffered, Anthropic translation is text-only, browser clients cannot read the session headers they need, failover and metering under-count some attempts, session state is process-global, and zero-schema mode does not actually enforce a bounded state footprint.

This hardening pass makes the runtime faithful to the paper where the paper defines semantics, and uses production reverse-proxy practices from Headroom and current provider SDK/API contracts where the paper is transport-agnostic.

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

- remain a small Node.js 20+ TypeScript package with zero runtime npm dependencies;
- preserve the exact Appendix A.4 SKILL.state prompt semantics for normal state transitions;
- make state mutation transactional: parse -> validate -> size/type/schema check -> merge -> atomically persist;
- support real long-running OpenAI-compatible tool loops, including parallel tool calls/results;
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

The current `src/proxy.ts` is doing transport, protocol conversion, session persistence, retry/failover, state mutation, cost metering, and HTTP routing in one file. The hardening pass separates the risky boundaries while preserving the existing public `startProxy()` entry point.

### Proposed source boundaries

- `src/proxy.ts` — HTTP route orchestration only: classify route, acquire session turn, call adapters/transport, finalize response.
- `src/transport.ts` — upstream URL construction, request headers, bounded retries, failover, client-abort propagation, non-stream and streaming transport.
- `src/sse.ts` — incremental SSE framing/parser helpers and bounded capture used for state/usage extraction.
- `src/session-store.ts` — per-proxy in-memory cache, TTL, per-session serialization, load/validate, atomic temp-file + rename persistence, delete/list.
- `src/headers.ts` — end-to-end header allow/strip rules, CORS and exposed response headers.
- `src/config.ts` — path expansion, CLI/config/env validation, precedence helpers.
- `src/anthropic.ts` — Anthropic Messages <-> OpenAI Chat protocol adapter for supported text/tools, including streaming event translation.
- `src/state.ts` — paper semantics only: prompt construction, transition parsing, validation, merge, state-size guard.
- `src/pricing.ts` / `src/cost-ledger.ts` — explicit known/unknown pricing and per-attempt aggregation.

No runtime dependency is added unless an implementation requirement cannot be met correctly with Node 20+ stdlib. The default plan is zero new runtime dependencies.

## State and transition semantics

### Paper format

For non-tool final responses, the proxy persists state only when it can validate the paper format:

```json
{
  "state_patch": { "key": "value", "old_key": null },
  "action": "exact action"
}
```

The containing JSON object must have exactly `state_patch` and `action`. `state_patch` must be a plain JSON object and `action` must be a string. Legacy formats may remain parseable in the exported library helper for compatibility, but the proxy will not mutate persistent state from a legacy/non-paper response.

### Transactional validation

A proposed transition is validated before the live session object is changed. Validation covers:

- exact paper envelope for normal final responses;
- JSON-serializable patch values;
- schema membership in strict mode;
- stable top-level value kinds when a type contract can be inferred from `initialState` or explicitly configured;
- `null` as deletion regardless of the prior value kind;
- maximum patch bytes;
- maximum merged state bytes.

If validation fails, the same logical step is rollback-retried up to `maxRetries`. Failed attempts do not increment the session step and cannot mutate state. If retries are exhausted, the final upstream response is returned, state remains unchanged, and the transition failure is observable.

### Schema modes and boundedness

Paper-faithful mode requires a fixed domain schema.

Compatibility behavior is retained for users who do not yet provide one:

- if `schema` is provided, it is strict;
- if `schema` is omitted but `initialState` has keys, the initial keys become the fixed top-level schema;
- if neither is provided, the proxy enters explicit compatibility mode rather than silently claiming schema fidelity.

Both modes enforce a fixed `maxStateBytes` so prompt size cannot grow without bound in `T`. Compatibility mode is documented as weaker semantically than the paper because arbitrary top-level keys can still churn within the byte cap.

New defaults:

- `maxStateBytes`: 65,536 bytes
- `maxPatchBytes`: 32,768 bytes
- `maxBodyBytes`: 1,048,576 bytes (existing)
- `maxResponseCaptureBytes`: 2,097,152 bytes for bounded post-stream state/usage parsing

A size violation rejects the transition; it never truncates semantic state silently.

## Tool-call execution extension

The paper defines `a_t` abstractly; HTTP SDKs represent actions as native tool calls. The proxy must preserve native tool semantics instead of forcing all tools into a textual action string.

### OpenAI client flow

Client tool definitions and `tool_choice` pass through unchanged to an OpenAI-compatible upstream.

If an upstream response contains native `tool_calls`:

- the tool calls are returned to the client unchanged;
- any valid paper-format state patch present in assistant text is applied;
- when no state patch accompanies the native tool call, the turn is treated as a documented native-tool no-op transition rather than inventing state;
- the next request's latest observation includes the immediately preceding assistant tool calls plus all contiguous tool-result messages, preserving parallel call IDs and results without replaying older history.

This is a practical transport extension to the paper. The semantic state should be updated on the following tool-result step if the model did not project state before issuing the tool call.

### Multiple/parallel tool results

`O_t` must include the entire newest tool-result batch, not merely the final `role: "tool"` message. This prevents loss of sibling results from parallel tool calls.

The capture is still bounded by the request body limit; the proxy does not silently truncate one sibling result.

## Anthropic Messages adapter

Anthropic support is a protocol conversion boundary, not string flattening.

Supported request conversion:

- top-level `system` text -> OpenAI system message;
- Anthropic text blocks -> OpenAI message text;
- custom `tools: [{name, description, input_schema}]` -> OpenAI function tools;
- `tool_choice: auto|any|tool|none` -> the nearest OpenAI tool-choice contract;
- `disable_parallel_tool_use: true` -> `parallel_tool_calls: false` where applicable;
- assistant `tool_use` blocks -> OpenAI assistant `tool_calls`;
- user `tool_result` blocks -> OpenAI `role: "tool"` messages with the matching call ID;
- mixed text + tool blocks are preserved in order as far as the destination protocol permits.

Supported response conversion:

- OpenAI assistant text -> Anthropic `text` block;
- OpenAI `tool_calls` -> Anthropic `tool_use` blocks;
- OpenAI `finish_reason: "tool_calls"` -> Anthropic `stop_reason: "tool_use"`;
- usage fields -> Anthropic input/output token fields when available.

Unsupported content-block types must produce an explicit 400 compatibility error rather than being silently dropped.

## Streaming contract

### OpenAI-compatible client -> OpenAI-compatible upstream

Streaming must be byte-faithful for upstream SSE payload bytes. `callUpstream()` may not call `Response.text()` for a stream.

The transport will:

1. obtain upstream status/headers;
2. make the failover decision before committing downstream headers;
3. stream body chunks to the client immediately with backpressure;
4. feed the same chunks into a bounded incremental SSE observer for text/tool/usage/state extraction;
5. abort the upstream fetch if the downstream client disconnects;
6. finalize state/ledger after the stream ends.

The regression test must prove that the client receives the first SSE chunk before the mock upstream sends its final chunk.

### Anthropic client -> OpenAI-compatible upstream

The proxy incrementally translates OpenAI ChatCompletion chunks into Anthropic Messages SSE events. It must emit the normal lifecycle (`message_start`, content block events, `message_delta`, `message_stop`) and support both text deltas and streamed function arguments/tool calls.

### Streaming retry rule

Once any downstream response body bytes have been committed, the proxy will not replay or fail over the request. Doing so can duplicate generated actions/tool calls and corrupt client protocol state.

Therefore rollback-retry for a missing state patch is only transparent for non-streaming responses. Streaming responses perform best-effort state projection after completion. A missing/invalid streamed patch leaves state unchanged and records the transition status for inspection/logging.

## Session store and concurrency

The module-global session map is replaced by a `SessionStore` owned by each `startProxy()` instance.

`SessionStore` responsibilities:

- validate session IDs;
- maintain TTL and list/delete semantics;
- validate loaded session file shape before trusting it;
- atomically persist via write-temp + rename;
- serialize logical turns for the same session so concurrent requests cannot interleave reads and lost updates;
- allow different sessions to proceed concurrently;
- clean timers on proxy close.

The on-disk session remains the source of restart persistence.

### Session identity

Explicit `x-skillstate-session` remains authoritative.

The legacy deterministic fallback based only on `(system prompt, model)` is unsafe for multiple simultaneous jobs with the same spec. The new behavior is:

- use a valid explicit session header when supplied;
- otherwise honor a documented stable session key from supported request metadata when present;
- otherwise create a new random session ID and return it in `x-skillstate-session`.

Documentation must no longer imply that unrelated zero-header requests with the same system/model can safely share state. Long-horizon clients should echo the returned session ID (for example using SDK `extra_headers`).

## Upstream transport, retry, failover, and rate limits

`transport.ts` owns all upstream attempt policy.

### Header timing

No downstream status/body bytes are committed until an upstream has returned a non-retry/failover status. This makes failover safe before streaming begins.

### Local limiter

A locally rate-limited upstream is skipped so the next configured upstream can be attempted. The request is not immediately rejected while another viable upstream exists.

An accepted attempt is recorded in RPM/TPM accounting before sending it, not only after success.

### Retryable failures

Before response commit, bounded retry/failover applies to:

- connection/network failures;
- upstream 408/429;
- upstream 5xx.

`Retry-After` is honored when parseable and less than the configured cap. Otherwise exponential backoff with jitter is used. Defaults should stay conservative so an interactive tool loop does not stall for minutes.

Authentication/permission errors (401/403) are terminal for that upstream but may fail over to a separately configured upstream with its own credentials. They are not silently rewritten into success.

### No retries after commit

A mid-stream disconnect is surfaced as a stream failure and recorded. It is not replayed on another provider after output/tool-call bytes may already have reached the client.

## Header and CORS contract

The proxy preserves safe end-to-end request headers while stripping:

- `host` and content length values that Node must recalculate;
- hop-by-hop headers (`connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`, plus tokens named by `Connection`);
- `x-skillstate-*` internal control/observability headers before external upstream forwarding.

Credential precedence:

1. explicit `upstream.headers` config;
2. configured `upstream.apiKey` supplies `Authorization: Bearer ...`;
3. otherwise inbound authorization may pass through for a true gateway configuration.

Secrets are never included in verbose logs or ledger rows.

CORS remains enabled by default for the loopback listener and adds `Access-Control-Expose-Headers` for all public SKILL.state response headers, including session, step, state keys, upstream, transition status, retries, and known cost fields.

## Observability and cost accounting

Every upstream attempt is represented internally. For each attempt the proxy records:

- upstream name and attempt number;
- status/failure class;
- model;
- input/output usage when the upstream supplies it;
- pricing status;
- cost when pricing is known;
- whether the attempt was a rollback-retry or transport retry.

A single client request's `x-skillstate-cost-usd` represents the sum of known-cost upstream generations for that logical turn, including rollback retries. If model pricing is unknown, the proxy must not report `$0` as if it were free; it exposes an explicit unknown pricing status and still records token usage.

Static prices remain estimates with source/as-of metadata. Unknown hosted models are unknown, not local/free. Explicit local upstream configuration may be priced at zero.

## CLI and configuration

Configuration precedence is exactly:

`defaults < config file < environment < CLI`.

Hardening requirements:

- validate numeric flags and required flag values;
- distinguish optional auto-discovery of `./skillstate.json` from an explicitly requested missing `--config` file;
- catch malformed `SKILLSTATE_INITIAL_STATE` and print a concise configuration error;
- validate upstream URLs before the server starts;
- expand a leading `~` in filesystem paths;
- remove the stale `defaultModel` example property;
- stop hard-coding the CLI version independently from `package.json`;
- surface startup/listen errors rather than leaving an unhandled rejection;
- close the HTTP server and internal timers without calling `process.exit()` before shutdown completes.

Programmatic `listenPort: 0` remains supported for tests.

## Public HTTP behavior

Existing routes remain:

- `POST /v1/chat/completions`
- `POST /v1/messages`
- `GET /v1/models`
- `GET /health` and `/v1/health`
- `GET|DELETE /state` and `/v1/state`
- `GET /cost` and `/v1/cost`

Management responses remain JSON and include explicit error content types for 4xx/5xx.

`/health` should distinguish process liveness from upstream readiness instead of returning `ok: true` while every circuit is unavailable.

`/state?session=` may expose a non-secret last transition status so streaming validation failures are diagnosable after response headers have already been sent.

## Tests and user flows

The implementation is test-driven. Each defect receives a regression test that fails on `main` before the implementation change.

Required offline coverage:

1. **Paper prompt/transition tests** — exact A.4 prompt labels; exact envelope; null deletion; no mutation on invalid patch; schema/type/size rejection; retry preserves the same logical step.
2. **100+ step synthetic horizon** — fixed schema and fixed-size observations keep serialized state/prompt independent of prior-turn count; no old transcript appears in the prompt.
3. **OpenAI tool loop** — native tool call -> multiple parallel tool results -> next state/action; call IDs/results all survive in the newest observation.
4. **OpenAI streaming** — delayed mock upstream proves first-byte streaming; payload bytes are unchanged; final state/usage is captured.
5. **Anthropic text + tools** — request and response conversion for `tool_use`/`tool_result`, tool choice, mixed text/tool content, usage, stop reason.
6. **Anthropic streaming tools** — streamed OpenAI tool call arguments produce valid Anthropic tool-use SSE lifecycle.
7. **Session isolation** — two proxy instances with identical session IDs but different state dirs never share memory.
8. **Same-session concurrency** — two overlapping turns serialize and do not lose state updates.
9. **Failover** — local limiter, 429, 5xx, network failure, and 401/403 with alternate credentials; no failover once a stream body has committed.
10. **Metering** — rollback retries and transport retries count attempts; unknown pricing is not `$0`.
11. **CORS/header flow** — browser-readable SKILL.state headers; configured authorization precedence; hop-by-hop/internal headers do not leak upstream.
12. **CLI/package flow** — `--help`, `--version`, bad/missing values, bad env JSON, missing explicit config, tilde expansion, graceful startup failure, and package contents via `npm pack --dry-run`/equivalent smoke test.
13. **Static site flow** — home, anchors, external primary links, sitemap/robots, and custom 404 stay valid. Site copy distinguishes the currently published npm version from unreleased `main` behavior until a package is actually published.

Optional live tests remain opt-in behind environment variables and should exercise at least one real OpenAI-compatible upstream with a three-step state loop and a native tool call when credentials are available.

Vitest's long timeout is scoped only to opt-in live tests; offline tests use short deterministic timeouts.

## CI

CI remains Node 20 + 22 and must run:

- clean install;
- TypeScript build;
- offline tests;
- package smoke check;
- static docs checks.

Live provider tests remain opt-in and are not required for public PRs because they require credentials.

## Documentation and site truthfulness

README and Pages are rewritten after behavior is tested, not before.

The docs must make these distinctions explicit:

- paper-faithful mode requires a fixed domain schema;
- compatibility mode is byte-bounded but semantically weaker;
- the proxy does not preserve full historical chat;
- native tool calls are supported, with state projection possibly occurring on the following tool-result step when the model emits no state patch alongside the tool call;
- streaming is truly incremental, but post-stream invalid-state rollback cannot be transparently replayed after bytes are delivered;
- explicit session IDs are required to safely distinguish multiple simultaneous jobs;
- unknown pricing is unknown rather than zero;
- SKILL.state is for long execution history, while very large individual tool payloads may still benefit from an orthogonal compressor such as Headroom;
- the paper's stated limitations remain limitations of this implementation.

No benchmark value is presented as a universal guarantee. Repo-measured values remain labeled by provider/model/date and paper values remain clearly attributed to the paper.

## Compatibility and release handling

The public package is currently `0.1.2`. Source changes are developed on the hardening branch without pretending npm already contains them.

Where practical, existing `startProxy`, route names, environment variables, and public exports are preserved. Any TypeScript signature that must change to eliminate a misleading semantic contract (notably unknown price being represented as zero) must be called out in release notes before the next npm publish.

The website must identify the currently published npm version separately from unreleased source until the user publishes a new package version.

## Acceptance criteria

The hardening branch is ready to merge only when all of the following are true:

- clean build and full offline suite pass on Node 20 and 22;
- no runtime npm dependency has been added;
- same-protocol OpenAI SSE delivers the first chunk before upstream completion and preserves payload bytes;
- OpenAI and Anthropic native tool loops work in non-streaming and supported streaming paths;
- invalid state patches cannot mutate disk or memory state;
- fixed-schema 100+ step tests do not replay history and remain bounded in execution-horizon growth;
- session isolation and same-session serialization tests pass;
- failover works before response commit and never replays a committed stream;
- every actual model generation/retry with reported usage is included in metering;
- browser JavaScript can read the SKILL.state response headers;
- CLI/package/static-site user flows pass;
- README and Pages no longer advertise behavior that is absent or weaker in the implementation;
- latest branch CI is green before any completion claim.
