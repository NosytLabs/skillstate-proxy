# Security

## Reporting

Email or open a private GitHub security advisory on [NosytLabs/skillstate-proxy](https://github.com/NosytLabs/skillstate-proxy). Do not file public issues for live credentials.

## Config and keys

- Never commit real API keys. Copy `skillstate.json.example` to `skillstate.json` (gitignored) or use `SKILLSTATE_API_KEY`.
- The proxy binds to `127.0.0.1` by default. Do not expose it on a public interface without auth in front.
- Rotate any key that was ever committed or pasted into a config file in git.

## What this proxy does not do

It rewrites LLM prompts. Side effects (file writes, shell, network) stay in the client. Treat model output as untrusted.
