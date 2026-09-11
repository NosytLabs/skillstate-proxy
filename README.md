# skillstate-proxy

A local HTTP proxy for agent workflows that can represent their progress as explicit structured state.

[Documentation](https://nosytlabs.github.io/skillstate-proxy/) · [npm package](https://www.npmjs.com/package/skillstate-proxy) · [CI runs](https://github.com/NosytLabs/skillstate-proxy/actions) · [Security](SECURITY.md)

## What it does

The proxy sits between a client and a configured model provider. It builds context from the task specification, the session's JSON state and the latest observation, then extracts a `state_patch` from the model's response.

This can reduce repeated history on a suitable workload. **Savings, latency, accuracy and provider compatibility are not guaranteed.** State design, observation size, model output, retries, output tokens and billing rules all affect the result.

This repository contains software you run yourself. The GitHub Pages site is **not a hosted inference API**. Requests to the configured upstream may incur charges. `skillstate-proxy` and the separately maintained npm package `skillstate` are different projects.

## Install

The package declares Node.js 20 or newer. Use a currently supported Node.js release compatible with your installed package, then inspect its help:

```sh
npm install -g skillstate-proxy
skillstate --version
skillstate --help
```

The executable is `skillstate`, also available as `skillstate-proxy`. Configure `SKILLSTATE_UPSTREAM` and `SKILLSTATE_API_KEY` in your local environment before starting:

```sh
skillstate --schema step,notes,findings
```

The default listener is `127.0.0.1:8789`. A compatible chat client uses `http://127.0.0.1:8789/v1` as its API base and a model supported by the configured upstream. Verify a short synthetic workflow before using sensitive data. A source checkout and the published npm package can contain different revisions.

## State contract

Example model response:

```json
{
  "state_patch": { "step": 2, "notes": "Checked the input format" },
  "action": "Continue with validation"
}
```

The state merge replaces arrays, recursively merges objects, and deletes a key when its patch value is null. Resend the full array when a list must survive. The runtime constructs subsequent context from the retained state rather than replaying the full transcript.

**This is not a lossless transcript archive.** A fact not preserved in state may be unavailable later. Keep a separate audit record when verbatim evidence or the complete sequence of actions matters. A list of allowed keys alone does not bound the size of values, arrays or observations; do not infer a fixed token budget or constant response time from that list.

## Configuration

Start with [skillstate.json.example](skillstate.json.example). Never commit real keys or sensitive state.

| Setting | Purpose |
| --- | --- |
| `SKILLSTATE_UPSTREAM` | Upstream API base URL |
| `SKILLSTATE_API_KEY` | Credential for that upstream |
| `SKILLSTATE_PORT` | Local listening port; default 8789 |
| `SKILLSTATE_SCHEMA` | Comma-separated allowed state keys |
| `SKILLSTATE_INITIAL_STATE` | Initial state encoded as JSON |
| `SKILLSTATE_CONFIG` | Configuration file path |
| `SKILLSTATE_VERBOSE` | Verbose logging switch |

The CLI also accepts `--config`, `--upstream`, `--port`, `--schema` and `--verbose`. For overlapping settings, precedence is CLI flags, environment variables, configuration file, then defaults. Consult the installed version's help for supported values.

State is persisted locally and can contain sensitive task information. The upstream receives the rewritten context. Keep the listener private and review [SECURITY.md](SECURITY.md) before deployment. This project is not a multi-tenant security boundary merely because it has session IDs.

## HTTP surface

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/chat/completions` | Chat-completion requests with state handling |
| POST | `/v1/messages` | Anthropic-format translation path |
| GET | `/v1/models` | Upstream model listing |
| GET | `/health` | Proxy and upstream circuit status |
| GET | `/state` | List sessions; use `?session=ID` to inspect one |
| DELETE | `/state?session=ID` | Reset that session |
| GET | `/cost` | Recorded cost summary, not a provider invoice |

An implemented route is not proof that every SDK feature works. Test streaming, tool-call/result correlation, concurrent sessions, retries and cancellation against your exact client, provider and model. The source tests and open hardening pull requests document the implementation more precisely than a universal compatibility claim would.

## Verify from source

```sh
npm ci
npm run build
npm test
```

See [Actions](https://github.com/NosytLabs/skillstate-proxy/actions) for revision-specific results. Skipped integration tests do not verify a live provider. No fixed passing-test count is embedded in this README.

Optional static-page layout verification uses Python Playwright:

```sh
python scripts/check_docs_layout.py
```

Install Playwright and its Chromium browser in a development environment first. Set `CHROMIUM_EXECUTABLE` to use an existing compatible browser. This check reads only the local documentation page and blocks network access; it does not test the inference API.

## Benchmarks and research

[Conversation benchmark](test/benchmark.ts) · [Tool-loop benchmark](test/benchmark-tools.ts) · [Research notes](references/skill-state-paper.md)

Live benchmarks require explicit provider configuration and can cost money:

```sh
npm run bench -- 50
npm run bench:tools -- 20
```

Retain the source revision, workload, model, state schema, raw provider usage, retries, quality scores and failures with any result. Compare total billed input/output costs, not just one prompt count. Historical measurements remain in Git history; they are not a promise for another workload or a current price quote.

The project draws on the [SKILL.state paper](https://arxiv.org/abs/2608.26263). Research results do not establish this implementation's accuracy or universal compatibility. Avoid this approach when you cannot define the retained state, when important details only become relevant later, or when short conversations do not justify the overhead.

## License

[MIT](LICENSE). This project is not affiliated with OpenAI or Anthropic. The software license does not include upstream inference or hosting.
