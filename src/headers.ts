export interface UpstreamHeaderConfig {
  apiKey?: string;
  headers?: Record<string, string>;
}

export const PUBLIC_SKILLSTATE_HEADERS = [
  "x-skillstate-session",
  "x-skillstate-step",
  "x-skillstate-statekeys",
  "x-skillstate-upstream",
  "x-skillstate-validation",
  "x-skillstate-transition",
  "x-skillstate-retries",
  "x-skillstate-action",
  "x-skillstate-cost-usd",
  "x-skillstate-cost-gnk",
  "x-skillstate-pricing",
] as const;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function scalarHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}

export function buildUpstreamHeaders(
  incoming: Record<string, string | string[] | undefined>,
  upstream: UpstreamHeaderConfig,
): Record<string, string> {
  const connectionTokens = new Set(
    (scalarHeader(incoming.connection) ?? "")
      .split(",")
      .map(v => v.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: Record<string, string> = {};

  for (const [rawName, rawValue] of Object.entries(incoming)) {
    const name = rawName.toLowerCase();
    const value = scalarHeader(rawValue);
    if (value === undefined) continue;
    if (name === "host" || name === "content-length") continue;
    if (HOP_BY_HOP.has(name) || connectionTokens.has(name)) continue;
    if (name.startsWith("x-skillstate-")) continue;
    out[name] = value;
  }

  const explicit = new Map<string, string>();
  for (const [rawName, value] of Object.entries(upstream.headers ?? {})) {
    explicit.set(rawName.toLowerCase(), value);
  }

  if (!explicit.has("authorization") && upstream.apiKey) {
    out.authorization = `Bearer ${upstream.apiKey}`;
  }
  for (const [name, value] of explicit) out[name] = value;

  return out;
}

export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-skillstate-session",
    "access-control-expose-headers": PUBLIC_SKILLSTATE_HEADERS.join(", "),
  };
}
