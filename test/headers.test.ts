import { describe, expect, it } from "vitest";
import { buildUpstreamHeaders, corsHeaders, PUBLIC_SKILLSTATE_HEADERS } from "../src/headers.js";

describe("proxy headers", () => {
  it("strips hop-by-hop, Connection-named, host, length, and internal headers", () => {
    const headers = buildUpstreamHeaders({
      host: "proxy.local",
      "content-length": "99",
      connection: "keep-alive, x-remove-me",
      "keep-alive": "timeout=5",
      "x-remove-me": "secret-hop",
      "x-skillstate-session": "session",
      "content-type": "application/json",
      "x-client-meta": "keep",
      authorization: "Bearer inbound",
    }, {});
    expect(headers["host"]).toBeUndefined();
    expect(headers["content-length"]).toBeUndefined();
    expect(headers["connection"]).toBeUndefined();
    expect(headers["keep-alive"]).toBeUndefined();
    expect(headers["x-remove-me"]).toBeUndefined();
    expect(headers["x-skillstate-session"]).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-client-meta"]).toBe("keep");
    expect(headers.authorization).toBe("Bearer inbound");
  });

  it("uses configured API key over inbound authorization", () => {
    const headers = buildUpstreamHeaders({ authorization: "Bearer inbound" }, { apiKey: "configured" });
    expect(headers.authorization).toBe("Bearer configured");
  });

  it("uses explicit upstream authorization header over apiKey", () => {
    const headers = buildUpstreamHeaders(
      { authorization: "Bearer inbound" },
      { apiKey: "configured", headers: { Authorization: "Custom explicit" } },
    );
    expect(headers.authorization).toBe("Custom explicit");
  });

  it("exposes public skillstate headers to browser clients", () => {
    const headers = corsHeaders();
    const exposed = headers["access-control-expose-headers"].split(",").map(s => s.trim().toLowerCase());
    for (const name of PUBLIC_SKILLSTATE_HEADERS) expect(exposed).toContain(name);
    expect(headers["access-control-allow-origin"]).toBe("*");
    expect(headers["access-control-allow-methods"]).toContain("DELETE");
  });
});
