function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

function assistantRecord(message: any): Record<string, unknown> {
  return {
    role: "assistant",
    content: message?.content ?? "",
    tool_calls: Array.isArray(message?.tool_calls) ? message.tool_calls : [],
  };
}

function toolRecord(message: any): Record<string, unknown> {
  return {
    role: "tool",
    tool_call_id: message?.tool_call_id,
    name: message?.name,
    content: message?.content ?? "",
  };
}

/**
 * Return O_t: the newest environment observation only.
 * For native parallel tools, the environment observation is the whole contiguous
 * result batch plus the immediately preceding assistant tool-call record so call
 * ids stay paired with results.
 */
export function latestObservation(messages: any[]): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  let end = messages.length - 1;
  while (end >= 0 && messages[end]?.role === "system") end--;
  if (end < 0) return "";

  if (messages[end]?.role === "tool") {
    let start = end;
    while (start > 0 && messages[start - 1]?.role === "tool") start--;
    const toolResults = messages.slice(start, end + 1).map(toolRecord);
    const previous = start > 0 ? messages[start - 1] : undefined;
    return JSON.stringify({
      ...(previous?.role === "assistant" && Array.isArray(previous?.tool_calls)
        ? { assistant: assistantRecord(previous) }
        : {}),
      tool_results: toolResults,
    });
  }

  const message = messages[end];
  if (message?.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
    return JSON.stringify({ assistant: assistantRecord(message) });
  }
  return contentText(message?.content);
}
