/** Lightweight token estimator (fallback when upstream doesn't report usage). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // ~4 chars/token for English; a rough context estimate, not billable usage.
  return Math.ceil(text.length / 4);
}

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export function extractUsage(body: string): Usage | null {
  try {
    const j = JSON.parse(body);
    // support both prompt_tokens/completion_tokens and input_tokens/output_tokens (Anthropic)
    const u = j.usage;
    if (u && typeof u === "object" && !Array.isArray(u)) {
      const inTok = u.prompt_tokens ?? u.input_tokens ?? u.promptTokens;
      const outTok = u.completion_tokens ?? u.output_tokens ?? u.completionTokens;
      if (Number.isSafeInteger(inTok) && inTok >= 0 && Number.isSafeInteger(outTok) && outTok >= 0) {
        return {
          model: typeof j.model === "string" ? j.model : "",
          inputTokens: inTok,
          outputTokens: outTok,
        };
      }
    }
  } catch {
    /* not JSON */
  }
  return null;
}
