# Paper-Faithful Proxy Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `skillstate-proxy` a paper-faithful, production-safe long-horizon proxy with transactional bounded state, native tool loops, true streaming, correct Anthropic conversion, isolated sessions, reliable failover, and truthful docs.

**Architecture:** Keep `startProxy()` as the public entry point but split state/session/transport/protocol/header/config responsibilities out of `src/proxy.ts`. Treat state mutation as a transaction and treat streaming response commitment as the retry/failover boundary.

**Tech Stack:** Node.js >=20, TypeScript ESM, built-in `fetch`/Web Streams/HTTP/filesystem/crypto, Vitest 4, zero runtime npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-10-paper-faithful-proxy-hardening-design.md`

## Global Constraints

- Preserve Appendix A.4 `(P, Σ_t, O_t)` execution semantics.
- Persist state only after deterministic validation; failed transitions cannot increment or corrupt state.
- Keep zero runtime npm dependencies.
- Preserve Node.js >=20 support and the existing public `startProxy()` API.
- Never retry/fail over after downstream response bytes have been committed.
- Support OpenAI native tools and supported Anthropic custom tools, including parallel tool results.
- Enforce `maxStateBytes=65536`, `maxPatchBytes=32768`, `maxBodyBytes=1048576`, `maxResponseCaptureBytes=2097152` by default.
- Explicit session header is authoritative; absent header creates a random session id.
- Unknown hosted model pricing is unknown, not `$0`.

---

### Task 1: Transactional state validation

**Files:**
- Modify: `src/state.ts`
- Modify: `test/state.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produce `validateTransition(session, transition, options)` returning either an accepted candidate state or validation errors without mutating the live session.
- Produce `commitTransition(session, candidate)` to advance exactly one logical step.

- [ ] Add failing tests proving: proxy-format envelopes require exactly `state_patch` + `action`; schema violations do not mutate; inferred/explicit top-level types reject bad replacements; null deletion is allowed; oversize patch/state is rejected; failed validation does not increment `step`; native-tool no-op can advance one step without state mutation.
- [ ] Run the state tests and confirm the new assertions fail for the expected missing transactional API/behavior.
- [ ] Implement pure transition validation using a cloned candidate, byte-size checks with `Buffer.byteLength(JSON.stringify(...))`, strict schema when configured/inferred, explicit/inferred value-kind checks, and exact paper-envelope parsing for proxy persistence.
- [ ] Refactor existing `applyDelta()` only enough to preserve exported backwards compatibility while proxy code uses transactional APIs.
- [ ] Run state tests plus the full suite.

### Task 2: Isolated atomic session store

**Files:**
- Create: `src/session-store.ts`
- Create: `test/session-store.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produce class `SessionStore` with `get`, `save`, `delete`, `list`, `withSessionLock`, and `close`.
- `save` uses same-directory temp file + `renameSync` and validates serializable session shape.

- [ ] Add failing tests for cross-proxy isolation, TTL eviction, corrupted-file rejection, atomic persistence, same-session serialization, different-session concurrency, and cleanup on close.
- [ ] Run only the new session-store tests and verify RED.
- [ ] Implement the per-instance cache/locks and atomic filesystem persistence; remove all module-global session state from the future proxy path.
- [ ] Verify GREEN and run the full suite.

### Task 3: Headers, CORS, config, and pricing correctness

**Files:**
- Create: `src/headers.ts`
- Create: `src/config.ts`
- Create: `test/headers.test.ts`
- Create: `test/config.test.ts`
- Modify: `src/pricing.ts`
- Modify: `test/proxy.test.ts`
- Modify: `skillstate.json.example`

**Interfaces:**
- `buildUpstreamHeaders(incoming, upstream)` strips hop-by-hop/internal headers and applies credential precedence.
- `setCorsHeaders(res)` exposes all public `x-skillstate-*` response headers.
- `normalizeProxyConfig` expands `~`, validates numeric/url fields, infers schema from initial-state keys, and applies defaults.
- `priceFor` returns explicit known/unknown/local-zero status.

- [ ] Add failing tests for `Access-Control-Expose-Headers`, connection-token stripping, authorization precedence, tilde expansion, invalid URLs/numbers, inferred schema, explicit missing config handling, and unknown-vs-local pricing.
- [ ] Verify RED.
- [ ] Implement header/config helpers and pricing status without adding dependencies; remove stale `defaultModel` from example config.
- [ ] Verify GREEN and full suite.

### Task 4: Native tool observations and Anthropic protocol adapter

**Files:**
- Modify: `src/anthropic.ts`
- Modify: `test/anthropic.test.ts`
- Modify: `test/proxy.test.ts`

**Interfaces:**
- Anthropic request conversion maps `tool_use`, `tool_result`, custom tools, tool choice, and parallel-tool preference to OpenAI Chat shapes.
- Response conversion maps OpenAI text/tool calls/finish reasons back to Anthropic content blocks.
- Tool observation extraction includes the immediately preceding assistant tool calls plus every contiguous latest tool-result message.

- [ ] Add failing tests for two parallel OpenAI tool results, mixed assistant text + tool calls, Anthropic `tool_use` -> OpenAI `tool_calls`, `tool_result` -> `role:tool`, `tool_choice` mappings, OpenAI tool response -> Anthropic `tool_use`, and unsupported block -> 400 compatibility error.
- [ ] Verify RED.
- [ ] Implement explicit block-aware conversion; never silently flatten unsupported blocks.
- [ ] Update proxy observation construction to preserve the complete newest tool batch.
- [ ] Verify GREEN and full suite.

### Task 5: Upstream transport, retries, failover, and per-attempt accounting

**Files:**
- Create: `src/transport.ts`
- Create: `test/transport.test.ts`
- Modify: `src/rate-limiter.ts`
- Modify: `src/cost-ledger.ts`
- Modify: `src/proxy.ts`

**Interfaces:**
- `requestUpstream(...)` owns URL/header construction, connect/whole-request timeout, retry/failover decisions, and returns an uncommitted selected response.
- An accepted local limiter attempt is recorded before sending.
- Retryable: network, 408, 429, 5xx. 401/403 may move to next upstream. Local rate-limit skips to next upstream.

- [ ] Add failing tests for first-upstream local 429 -> second upstream, upstream 500 -> retry/failover, 401 -> alternate credentials/upstream, bounded `Retry-After`, no duplicate limiter accounting, and cost rows for rollback/transport attempts with known usage.
- [ ] Verify RED.
- [ ] Implement transport policy with conservative capped backoff/jitter, response-commit boundary, credential/header handling, and per-attempt metadata.
- [ ] Refactor proxy non-stream calls through transport and aggregate logical-turn cost from known attempts.
- [ ] Verify GREEN and full suite.

### Task 6: True SSE streaming and Anthropic streaming conversion

**Files:**
- Create: `src/sse.ts`
- Create: `test/sse.test.ts`
- Modify: `src/transport.ts`
- Modify: `src/proxy.ts`
- Modify: `src/anthropic.ts`
- Modify: `test/proxy.test.ts`

**Interfaces:**
- Incremental SSE parser accepts arbitrarily split chunks and exposes `data` frames without buffering whole streams.
- OpenAI->OpenAI stream is byte-faithful downstream while a bounded observer captures state/usage.
- OpenAI->Anthropic stream emits `message_start`, content-block events, `message_delta`, `message_stop`, including streamed function argument deltas.

- [ ] Add failing timing test where mock upstream emits chunk A, waits on a gate, then emits chunk B; assert client receives A before gate opens.
- [ ] Add failing tests for split SSE frames, usage extraction, disconnect abort, response-capture cap, streamed OpenAI tool call deltas, and Anthropic SSE lifecycle/tool events.
- [ ] Verify RED.
- [ ] Implement streaming via `Response.body.getReader()` and downstream backpressure; maintain proxy-owned whole-stream timeout and client-abort controller.
- [ ] Do not rollback-retry streamed state failures after bytes have been emitted; leave state unchanged and expose transition status.
- [ ] Verify GREEN and full suite.

### Task 7: Proxy orchestration and long-horizon concurrency

**Files:**
- Modify: `src/proxy.ts`
- Modify: `test/proxy.test.ts`
- Modify/Create: `test/horizon.test.ts`

**Interfaces:**
- `startProxy()` owns one `SessionStore`, transport policy, rate limiters, breakers, and ledger; `close()` cleans all resources.

- [ ] Add failing regression tests for random session ids when header absent, same-session overlapping requests serialized, two proxy instances with same sid isolated, transactional rollback after invalid response, 100+ step bounded prompt/state, and native tool-call no-op step followed by tool-result state update.
- [ ] Verify RED.
- [ ] Finish orchestration refactor so proxy routes compose the new units without module-global mutable state.
- [ ] Verify GREEN and full suite on Node 20/22 via PR CI.

### Task 8: CLI/package smoke, documentation, and published-site truthfulness

**Files:**
- Modify: `src/cli.ts`
- Create: `test/cli.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/index.html`
- Modify: `docs/styles.css` only if needed for changed copy/layout
- Modify: `docs/sitemap.xml` when publication date changes

**Interfaces:**
- CLI version is sourced from package metadata or injected build metadata, not duplicated manually.
- Explicit missing config, malformed initial-state JSON, invalid port/upstream, and startup/listen errors produce concise non-zero exits.
- SIGINT/SIGTERM await proxy close before process termination.

- [ ] Add failing CLI subprocess tests for `--version`, missing flag value, invalid port, explicit missing config, malformed env JSON, invalid upstream URL, and package binary aliases.
- [ ] Verify RED.
- [ ] Implement CLI/config hardening and graceful shutdown.
- [ ] Add a CI/package smoke command that builds, runs `npm pack --dry-run`/pack inspection, and executes both declared binaries with `--version`/`--help`.
- [ ] Update README and GitHub Pages copy so streaming, Anthropic support, session requirements, schema mode, limitations, pricing, retry/failover, and tool-loop claims match the automated tests exactly.
- [ ] Verify links/404/docs source and full PR CI.

### Task 9: Final verification and merge readiness

**Files:**
- Modify only files required by failures discovered during verification.

- [ ] Run/observe PR CI on Node 20 and 22: install, build, all offline tests.
- [ ] Confirm package smoke passes and no runtime dependencies were added.
- [ ] Inspect PR diff for accidental secrets, stale claims, dead code, unused config fields, and API regressions.
- [ ] Confirm every spec requirement maps to a test or explicit documented limitation.
- [ ] Mark PR ready only after all checks are green; do not merge automatically unless explicitly requested or already authorized by the user.
