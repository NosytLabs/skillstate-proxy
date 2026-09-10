import { describe, expect, it } from "vitest";
import { AnthropicCompatibilityError, denormalizeResponse, normalizeIncoming } from "../src/anthropic.js";

describe("Anthropic Messages adapter", () => {
  it("converts custom tools and tool choice to OpenAI shapes", () => {
    const n = normalizeIncoming("/v1/messages", {
      model: "claude-test",
      max_tokens: 200,
      system: "spec",
      tools: [{ name: "lookup", description: "Lookup", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
      tool_choice: { type: "tool", name: "lookup", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    })!;
    expect(n.source).toBe("anthropic");
    expect(n.raw.tools).toEqual([{ type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object", properties: { q: { type: "string" } } } } }]);
    expect(n.raw.tool_choice).toEqual({ type: "function", function: { name: "lookup" } });
    expect(n.raw.parallel_tool_calls).toBe(false);
    expect(n.messages[0]).toEqual({ role: "system", content: "spec" });
  });

  it("converts assistant tool_use and user tool_result without dropping text", () => {
    const n = normalizeIncoming("/v1/messages", {
      model: "claude-test",
      messages: [
        { role: "assistant", content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } },
        ] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "found" }] },
          { type: "text", text: "continue" },
        ] },
      ],
    })!;
    expect(n.messages[0].role).toBe("assistant");
    expect(n.messages[0].content).toBe("checking");
    expect(n.messages[0].tool_calls[0].id).toBe("call_1");
    expect(n.messages[0].tool_calls[0].function.arguments).toBe('{"q":"x"}');
    expect(n.messages.some((m: any) => m.role === "tool" && m.tool_call_id === "call_1" && m.content === "found")).toBe(true);
    expect(n.messages.some((m: any) => m.role === "user" && m.content === "continue")).toBe(true);
  });

  it.each([
    [{ type: "auto" }, "auto"],
    [{ type: "any" }, "required"],
    [{ type: "none" }, "none"],
  ])("maps tool_choice %j", (choice, expected) => {
    const n = normalizeIncoming("/v1/messages", { model: "x", tool_choice: choice, messages: [{ role: "user", content: "go" }] })!;
    expect(n.raw.tool_choice).toBe(expected);
  });

  it("maps OpenAI tool calls and finish reason back to Anthropic", () => {
    const normalized = normalizeIncoming("/v1/messages", { model: "x", messages: [{ role: "user", content: "go" }] })!;
    const out = denormalizeResponse(normalized, {
      id: "m1", model: "x",
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "checking", tool_calls: [
        { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } },
      ] } }],
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    });
    expect(out.stop_reason).toBe("tool_use");
    expect(out.content).toEqual([
      { type: "text", text: "checking" },
      { type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } },
    ]);
    expect(out.usage).toEqual({ input_tokens: 12, output_tokens: 7 });
  });

  it("rejects unsupported content blocks instead of silently dropping them", () => {
    expect(() => normalizeIncoming("/v1/messages", {
      model: "x",
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "abc" } }] }],
    })).toThrow(AnthropicCompatibilityError);
    try {
      normalizeIncoming("/v1/messages", { model: "x", messages: [{ role: "user", content: [{ type: "image" }] }] });
    } catch (e) {
      expect((e as AnthropicCompatibilityError).statusCode).toBe(400);
    }
  });
});
