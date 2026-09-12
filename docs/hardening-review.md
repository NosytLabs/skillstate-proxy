# Hardening review: source branch, not a package release

This document accompanies PR #10. Passing offline tests is not evidence of live-provider compatibility, accurate provider invoices, complete multi-tenant isolation, or a released npm version. The public Pages site and an installed npm package may describe or contain a different revision.

## Behavior covered by this continuation

The permissive `extractDelta` compatibility helper retains the main-branch no-op, wrapper and alias regressions. Proxy persistence uses the separate, stricter `parsePaperTransition` contract: exactly `state_patch` plus a string `action`. Do not treat the compatibility helper as authorization to persist arbitrary legacy output.

`maxResponseCaptureBytes` limits retained raw and interpreted OpenAI streaming content. Once exceeded, an OpenAI stream can continue to pass through, but the captured prefix is not committed to session state and its incomplete usage is marked unavailable. Anthropic translation stops on capture overflow because continuing to synthesize a partial translated response would be misleading. An SSE frame also has a byte limit. These are application-level retention limits, not a claim that network buffers or every allocation consume exactly that amount of memory.

The same configured limit bounds buffered non-stream replies, model-list replies, and upstream error bodies. Oversized buffered replies fail with 502 without committing their prefix. Interrupted reads always release their timeout lifecycle. Client disconnection propagates to an upstream still waiting for its first response headers; waits for downstream drain are cancellation-aware.

Reset requests acquire the same per-session lock as generation. A reset accepted behind a generation removes the resulting session rather than letting the earlier generation resurrect it. The guarantee is process-local; this is not a cross-process distributed lock. Mutating a detached candidate before the atomic file write prevents failed persistence from corrupting the cached previous state.

Metering accepts only explicit nonnegative safe-integer input and output token counts. Missing or malformed usage is unavailable, not zero-cost usage. Usage-unavailable successful generations have an attempt row with no USD amount; zero token placeholders in that row are not measured tokens. When the provider reports a model ID, it takes precedence over a client alias. Bundled prices are dated estimates; provider-specific pricing overrides and current invoice reconciliation remain necessary.

## Verification

Run the full repository build and suite, plus the packed-CLI smoke test in `.github/workflows/ci.yml`. `test/review-boundaries.test.ts` and `test/review-proxy-boundaries.test.ts` cover the new failure paths. The reset test uses a controlled in-flight upstream and actual reset arrival rather than a fixed scheduling sleep. The persistence-failure test injects a failing store write; other proxy tests use real local HTTP servers. No production keys, paid models, real user sessions or payment actions are used.

## Remaining release gates

PR #10 must remain a draft until the complete hardening change has been reviewed, not just these incremental fixes. In particular, review persisted/configured initial-state size and shape limits, strict JSON-value/prototype-key handling, multiple-choice stream behavior, complete usage/error accounting, and restart/cross-process semantics. The tests do not certify these broader guarantees. No package registry publication or repository About-metadata update is performed by this source change.
