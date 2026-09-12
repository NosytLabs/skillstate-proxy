import { describe, expect, it } from "vitest";
import { BoundedCapture, OpenAIStreamObserver, SseParser } from "../src/sse.js";

describe("SseParser", () => {
  it("parses frames split across arbitrary chunks", () => {
    const p = new SseParser();
    expect(p.feed("data: {\"x\":" )).toEqual([]);
    expect(p.feed("1}\n")).toEqual([]);
    expect(p.feed("\n")).toEqual([{ data: '{"x":1}' }]);
  });

  it("joins multiple data lines and preserves event name", () => {
    const p = new SseParser();
    expect(p.feed("event: thing\ndata: a\ndata: b\n\n")).toEqual([{ event: "thing", data: "a\nb" }]);
  });
});

describe("BoundedCapture", () => {
  it("caps retained bytes and marks truncation", () => {
    const c = new BoundedCapture(5);
    c.append("abc");
    c.append("def");
    expect(c.text()).toBe("abcde");
    expect(c.truncated).toBe(true);
  });
});

describe("OpenAIStreamObserver", () => {
  it("accumulates text and final usage from SSE", () => {
    const o = new OpenAIStreamObserver(1024);
    o.feed('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n');
    o.feed('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
    o.feed('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5}}\n\n');
    o.feed("data: [DONE]\n\n");
    const r = o.result();
    expect(r.content).toBe("hello");
    expect(r.inputTokens).toBe(12);
    expect(r.outputTokens).toBe(5);
    expect(r.truncated).toBe(false);
  });

  it("reassembles streamed function tool call arguments", () => {
    const o = new OpenAIStreamObserver(2048);
    o.feed('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\\"q\\\":"}}]}}]}\n\n');
    o.feed('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\\"x\\\"}"}}]}}]}\n\n');
    o.feed("data: [DONE]\n\n");
    const r = o.result();
    expect(r.toolCalls).toEqual([{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }]);
  });
});
