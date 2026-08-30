/**
 * Model-agnostic translator: Anthropic /v1/messages <-> OpenAI /v1/chat/completions
 * Lets skillstate-proxy sit in front of Claude, OpenAI, or any OpenAI-compatible upstream
 * without the client needing to know. Inspired by headroom's OpenAI-compat passthrough
 * but extended for Anthropic wire format.
 */

export type NormalizedRequest = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream: boolean;
  raw: any;
  source: "openai" | "anthropic";
};

export function normalizeIncoming(url: string, body: any): NormalizedRequest | null {
  // Strongest signal: Anthropic sends `content` as an array of blocks OR a top-level `system` field.
  // OpenAI sends `content` as a string and no top-level `system` (system is a message).
  const firstContent = body?.messages?.[0]?.content;
  const hasContentArray = Array.isArray(firstContent);
  const hasAnthropicSystem = typeof body?.system === "string" && Array.isArray(body?.messages?.[0]?.content);
  const isAnthropicPath = url.includes("/v1/messages");

  if ((hasContentArray || hasAnthropicSystem || isAnthropicPath) && body?.messages && body?.model) {
    // disambiguate: if content is string and no system field, it's likely OpenAI — but /v1/messages path wins
    if (!hasContentArray && !hasAnthropicSystem && !isAnthropicPath) {
      // ambiguous, treat as openai below
    } else {
      return anthropicToOpenAI(body);
    }
  }
  if (url.includes("/v1/chat/completions") || url.includes("/chat/completions")) {
    return {
      model: body?.model ?? "",
      messages: body?.messages ?? [],
      stream: !!body?.stream,
      raw: body,
      source: "openai",
    };
  }
  // fallback: treat as OpenAI
  if (body?.messages) {
    return { model: body?.model ?? "", messages: body.messages, stream: !!body?.stream, raw: body, source: "openai" };
  }
  return null;
}

function anthropicToOpenAI(body: any): NormalizedRequest {
  const msgs: Array<{ role: string; content: string }> = [];
  if (body.system) msgs.push({ role: "system", content: body.system });
  for (const m of body.messages ?? []) {
    const content = Array.isArray(m.content) ? m.content.map((c: any) => c.text ?? "").join("\n") : String(m.content ?? "");
    msgs.push({ role: m.role, content });
  }
  return { model: body.model ?? "", messages: msgs, stream: !!body.stream, raw: body, source: "anthropic" };
}

export function denormalizeResponse(normalized: NormalizedRequest, openAIJson: any): any {
  if (normalized.source === "anthropic") {
    const content = openAIJson.choices?.[0]?.message?.content ?? "";
    return {
      id: openAIJson.id ?? "msg_skillstate",
      type: "message",
      role: "assistant",
      model: openAIJson.model ?? normalized.model,
      content: [{ type: "text", text: content }],
      stop_reason: "end_turn",
      usage: openAIJson.usage ? { input_tokens: openAIJson.usage.prompt_tokens, output_tokens: openAIJson.usage.completion_tokens } : undefined,
    };
  }
  return openAIJson;
}
