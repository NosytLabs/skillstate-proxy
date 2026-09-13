import { describe, expect, it } from "vitest";
import { latestObservation } from "../src/observation.js";

describe("latestObservation", () => {
  it("includes the preceding assistant tool calls and all contiguous tool results", () => {
    const observation = latestObservation([
      { role: "user", content: "run both" },
      { role: "assistant", content: "", tool_calls: [
        { id: "call_1", type: "function", function: { name: "a", arguments: "{}" } },
        { id: "call_2", type: "function", function: { name: "b", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "call_1", name: "a", content: "A" },
      { role: "tool", tool_call_id: "call_2", name: "b", content: "B" },
    ]);
    const parsed = JSON.parse(observation);
    expect(parsed.assistant.tool_calls).toHaveLength(2);
    expect(parsed.tool_results).toHaveLength(2);
    expect(parsed.tool_results.map((r: any) => r.tool_call_id)).toEqual(["call_1", "call_2"]);
  });

  it("uses the latest ordinary non-system message when no tool batch exists", () => {
    expect(latestObservation([
      { role: "system", content: "spec" },
      { role: "user", content: "latest" },
    ])).toBe("latest");
  });
});
