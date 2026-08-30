/** Lightweight token estimator (fallback when upstream doesn't report usage). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // ~4 chars/token for English; rough but adequate for metering.
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
    if (u) {
      const inTok = u.prompt_tokens ?? u.input_tokens ?? u.promptTokens ?? 0;
      const outTok = u.completion_tokens ?? u.output_tokens ?? u.completionTokens ?? 0;
      if (inTok != null || outTok != null) {
        return {
          model: j.model ?? "",
          inputTokens: inTok ?? 0,
          outputTokens: outTok ?? 0,
        };
      }
    }
  } catch {
    /* not JSON */
  }
  return null;
}
