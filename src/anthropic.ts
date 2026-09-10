/** Anthropic Messages <-> OpenAI Chat protocol adapter. */

export class AnthropicCompatibilityError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "AnthropicCompatibilityError";
  }
}

export type NormalizedRequest = {
  model: string;
  messages: any[];
  stream: boolean;
  raw: any;
  source: "openai" | "anthropic";
};

function textFromBlocks(blocks: any[], context: string): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block?.type !== "text" || typeof block.text !== "string") {
      throw new AnthropicCompatibilityError(`unsupported ${context} content block type: ${String(block?.type)}`);
    }
    parts.push(block.text);
  }
  return parts.join("\n");
}

function systemText(system: unknown): string | undefined {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return textFromBlocks(system, "system");
  if (system == null) return undefined;
  throw new AnthropicCompatibilityError("unsupported Anthropic system content");
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return textFromBlocks(content, "tool_result");
  if (content == null) return "";
  throw new AnthropicCompatibilityError("unsupported Anthropic tool_result content");
}

function convertMessages(messages: any[]): any[] {
  const out: any[] = [];
  for (const message of messages ?? []) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      throw new AnthropicCompatibilityError(`unsupported Anthropic message role: ${String(message?.role)}`);
    }
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) {
      throw new AnthropicCompatibilityError("Anthropic message content must be a string or block array");
    }

    if (message.role === "assistant") {
      const text: string[] = [];
      const toolCalls: any[] = [];
      for (const block of message.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          text.push(block.text);
        } else if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
        } else {
          throw new AnthropicCompatibilityError(`unsupported assistant content block type: ${String(block?.type)}`);
        }
      }
      out.push({
        role: "assistant",
        content: text.join("\n"),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    let pendingText: string[] = [];
    const flushText = () => {
      if (pendingText.length) {
        out.push({ role: "user", content: pendingText.join("\n") });
        pendingText = [];
      }
    };
    for (const block of message.content) {
      if (block?.type === "text" && typeof block.text === "string") {
        pendingText.push(block.text);
      } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        flushText();
        out.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: toolResultText(block.content),
          ...(block.name ? { name: String(block.name) } : {}),
        });
      } else {
        throw new AnthropicCompatibilityError(`unsupported user content block type: ${String(block?.type)}`);
      }
    }
    flushText();
  }
  return out;
}

function convertTools(tools: unknown): any[] | undefined {
  if (tools == null) return undefined;
  if (!Array.isArray(tools)) throw new AnthropicCompatibilityError("Anthropic tools must be an array");
  return tools.map((tool: any) => {
    if (!tool || typeof tool.name !== "string" || !tool.input_schema || typeof tool.input_schema !== "object") {
      throw new AnthropicCompatibilityError("unsupported Anthropic tool definition");
    }
    return {
      type: "function",
      function: {
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        parameters: tool.input_schema,
      },
    };
  });
}

function convertToolChoice(choice: any): { toolChoice?: any; parallel?: boolean } {
  if (choice == null) return {};
  switch (choice.type) {
    case "auto": return { toolChoice: "auto", ...(choice.disable_parallel_tool_use ? { parallel: false } : {}) };
    case "any": return { toolChoice: "required", ...(choice.disable_parallel_tool_use ? { parallel: false } : {}) };
    case "none": return { toolChoice: "none" };
    case "tool":
      if (typeof choice.name !== "string") throw new AnthropicCompatibilityError("tool_choice.type=tool requires name");
      return {
        toolChoice: { type: "function", function: { name: choice.name } },
        ...(choice.disable_parallel_tool_use ? { parallel: false } : {}),
      };
    default:
      throw new AnthropicCompatibilityError(`unsupported Anthropic tool_choice type: ${String(choice.type)}`);
  }
}

function anthropicToOpenAI(body: any): NormalizedRequest {
  if (!body || !Array.isArray(body.messages) || !body.model) {
    throw new AnthropicCompatibilityError("Anthropic Messages request requires model and messages");
  }
  const messages: any[] = [];
  const system = systemText(body.system);
  if (system !== undefined) messages.push({ role: "system", content: system });
  messages.push(...convertMessages(body.messages));

  const tools = convertTools(body.tools);
  const { toolChoice, parallel } = convertToolChoice(body.tool_choice);
  const {
    system: _system,
    messages: _messages,
    tools: _tools,
    tool_choice: _toolChoice,
    ...rest
  } = body;
  const raw = {
    ...rest,
    messages,
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(parallel !== undefined ? { parallel_tool_calls: parallel } : {}),
  };
  return { model: body.model, messages, stream: !!body.stream, raw, source: "anthropic" };
}

export function normalizeIncoming(url: string, body: any): NormalizedRequest | null {
  const isAnthropicPath = url.includes("/v1/messages");
  if (isAnthropicPath) return anthropicToOpenAI(body);
  if (url.includes("/v1/chat/completions") || url.includes("/chat/completions")) {
    return { model: body?.model ?? "", messages: body?.messages ?? [], stream: !!body?.stream, raw: body, source: "openai" };
  }
  if (body?.messages) {
    return { model: body?.model ?? "", messages: body.messages, stream: !!body?.stream, raw: body, source: "openai" };
  }
  return null;
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

function stopReason(finish: unknown): string {
  if (finish === "tool_calls") return "tool_use";
  if (finish === "length") return "max_tokens";
  return "end_turn";
}

export function denormalizeResponse(normalized: NormalizedRequest, openAIJson: any): any {
  if (normalized.source !== "anthropic") return openAIJson;
  const choice = openAIJson.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content: any[] = [];
  if (typeof message.content === "string" && message.content.length) {
    content.push({ type: "text", text: message.content });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (call?.type !== "function" || typeof call.id !== "string" || typeof call.function?.name !== "string") continue;
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: parseArguments(call.function.arguments),
      });
    }
  }
  return {
    id: openAIJson.id ?? "msg_skillstate",
    type: "message",
    role: "assistant",
    model: openAIJson.model ?? normalized.model,
    content,
    stop_reason: stopReason(choice.finish_reason),
    stop_sequence: null,
    usage: openAIJson.usage
      ? { input_tokens: openAIJson.usage.prompt_tokens ?? 0, output_tokens: openAIJson.usage.completion_tokens ?? 0 }
      : undefined,
  };
}
