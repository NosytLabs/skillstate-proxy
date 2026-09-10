import { describe, expect, it } from "vitest";
import { AnthropicStreamAdapter } from "../src/anthropic.js";

describe("AnthropicStreamAdapter", () => {
  it("emits Anthropic lifecycle and text deltas", () => {
    const a = new AnthropicStreamAdapter("model-x", "msg_1");
    const out = [
      ...a.push('{"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}'),
      ...a.push('{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}'),
      ...a.push("[DONE]"),
    ].join("");
    expect(out).toContain("event: message_start");
    expect(out).toContain('"type":"text_delta","text":"hi"');
    expect(out).toContain('"stop_reason":"end_turn"');
    expect(out).toContain("event: message_stop");
  });

  it("streams function calls as tool_use input_json_delta blocks", () => {
    const a = new AnthropicStreamAdapter("model-x", "msg_2");
    const out = [
      ...a.push('{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\\"q\\\":"}}]},"finish_reason":null}]}'),
      ...a.push('{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\\"x\\\"}"}}]},"finish_reason":"tool_calls"}]}'),
      ...a.push("[DONE]"),
    ].join("");
    expect(out).toContain('"type":"tool_use","id":"call_1","name":"lookup","input":{}');
    expect(out).toContain('"type":"input_json_delta"');
    expect(out).toContain('"stop_reason":"tool_use"');
  });
});
