import { extractUsage } from "./token-estimate.js";

export interface SseFrame {
  event?: string;
  data: string;
}

export class SseParser {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  constructor(private readonly maxFrameBytes = 1024 * 1024) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) throw new RangeError("invalid SSE frame limit");
  }

  private checkSize(value: string): void {
    if (Buffer.byteLength(value, "utf8") > this.maxFrameBytes) {
      this.buffer = "";
      throw new RangeError("SSE frame exceeded configured byte limit");
    }
  }

  feed(chunk: string | Uint8Array): SseFrame[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    this.buffer = this.buffer.replace(/\r\n/g, "\n");
    const frames: SseFrame[] = [];
    while (true) {
      const boundary = this.buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      this.checkSize(raw);
      const frame = this.parse(raw);
      if (frame) frames.push(frame);
    }
    this.checkSize(this.buffer);
    return frames;
  }

  end(): SseFrame[] {
    this.buffer += this.decoder.decode();
    this.checkSize(this.buffer);
    if (!this.buffer.trim()) { this.buffer = ""; return []; }
    const frame = this.parse(this.buffer.replace(/\r\n/g, "\n"));
    this.buffer = "";
    return frame ? [frame] : [];
  }

  private parse(raw: string): SseFrame | null {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      if (field === "data") data.push(value);
    }
    if (!event && data.length === 0) return null;
    return { ...(event ? { event } : {}), data: data.join("\n") };
  }
}

export class BoundedCapture {
  private chunks: Buffer[] = [];
  private retained = 0;
  truncated = false;

  constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("invalid capture byte limit");
  }

  append(chunk: string | Uint8Array): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    const room = Math.max(0, this.maxBytes - this.retained);
    if (buf.length > room) this.truncated = true;
    if (room > 0) {
      const kept = Buffer.from(buf.subarray(0, Math.min(room, buf.length)));
      this.chunks.push(kept);
      this.retained += kept.length;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export interface ObservedOpenAIStream {
  content: string;
  toolCalls: any[];
  inputTokens: number;
  outputTokens: number;
  truncated: boolean;
  raw: string;
  model: string;
  usageAvailable: boolean;
}

type ToolAccumulator = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export class OpenAIStreamObserver {
  private readonly parser: SseParser;
  private model = "";
  private usageAvailable = false;
  private readonly capture: BoundedCapture;
  private content = "";
  private inputTokens = 0;
  private outputTokens = 0;
  private readonly tools = new Map<number, ToolAccumulator>();

  constructor(maxCaptureBytes: number) {
    this.capture = new BoundedCapture(maxCaptureBytes);
    this.parser = new SseParser(maxCaptureBytes);
  }

  get truncated(): boolean { return this.capture.truncated; }

  feed(chunk: string | Uint8Array): void {
    if (this.capture.truncated) return;
    this.capture.append(chunk);
    if (this.capture.truncated) return;
    for (const frame of this.parser.feed(chunk)) this.observe(frame);
  }

  end(): void {
    if (this.capture.truncated) return;
    for (const frame of this.parser.end()) this.observe(frame);
  }

  private observe(frame: SseFrame): void {
    if (!frame.data || frame.data === "[DONE]") return;
    let json: any;
    try { json = JSON.parse(frame.data); }
    catch { return; }

    if (typeof json.model === "string") this.model = json.model;
    if (json.usage) {
      const usage = extractUsage(frame.data);
      this.usageAvailable = usage !== null;
      if (usage) {
        this.inputTokens = usage.inputTokens;
        this.outputTokens = usage.outputTokens;
      }
    }
    for (const choice of json.choices ?? []) {
      const delta = choice?.delta ?? {};
      if (typeof delta.content === "string") this.content += delta.content;
      for (const [fallbackIndex, part] of (delta.tool_calls ?? []).entries()) {
        const index = Number.isInteger(part?.index) ? part.index : fallbackIndex;
        const current = this.tools.get(index) ?? {
          id: "",
          type: "function" as const,
          function: { name: "", arguments: "" },
        };
        if (typeof part?.id === "string") current.id = part.id;
        if (typeof part?.function?.name === "string") current.function.name += part.function.name;
        if (typeof part?.function?.arguments === "string") current.function.arguments += part.function.arguments;
        this.tools.set(index, current);
      }
    }
  }

  result(): ObservedOpenAIStream {
    this.end();
    return {
      content: this.content,
      toolCalls: [...this.tools.entries()].sort(([a], [b]) => a - b).map(([, value]) => value),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      truncated: this.capture.truncated,
      raw: this.capture.text(),
      model: this.model,
      usageAvailable: this.usageAvailable && !this.capture.truncated,
    };
  }
}
