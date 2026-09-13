import { describe, expect, it } from 'vitest';
import { OpenAIStreamObserver, SseParser } from '../src/sse.js';
import { extractUsage } from '../src/token-estimate.js';
import { readFileSync } from 'node:fs';

const frame = (content: string) => 'data: '+JSON.stringify({choices:[{index:0,delta:{content}}]})+'\n\n';
describe('reviewed capture and usage boundaries', () => {
  it('stops retaining logical content after raw capture overflows', () => {
    const observer=new OpenAIStreamObserver(128);
    for(let i=0;i<20;i++) observer.feed(frame('x'.repeat(70)));
    const result=observer.result();
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.raw)).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(128);
  });
  it('does not parse a truncated prefix as a complete transition', () => {
    const observer=new OpenAIStreamObserver(32);
    observer.feed(frame('{"state_patch":{},"action":"done"}'));
    expect(observer.result().content).toBe('');
  });
  it('caps unterminated SSE frames', () => {
    const parser=new SseParser(32);
    expect(()=>parser.feed('data: '+'x'.repeat(100))).toThrow(/limit|exceed|large/i);
  });
  it('does not reject many complete small frames as one oversized frame', () => {
    const parser=new SseParser(16);
    expect(parser.feed('data: x\n\n'.repeat(30))).toHaveLength(30);
  });
  it.each([{}, {prompt_tokens:1}, {completion_tokens:1}, {prompt_tokens:'5',completion_tokens:1}, {prompt_tokens:-1,completion_tokens:1}, {prompt_tokens:1.5,completion_tokens:1}, {prompt_tokens:true,completion_tokens:1}, {prompt_tokens:1e100,completion_tokens:1}])('rejects missing or invalid usage %j', usage => {
    expect(extractUsage(JSON.stringify({model:'test',usage}))).toBeNull();
  });
  it('accepts explicit zero usage rather than assuming zero for missing fields', () => {
    expect(extractUsage('{"model":"test","usage":{"prompt_tokens":0,"completion_tokens":0}}')).toEqual({model:'test',inputTokens:0,outputTokens:0});
  });
  it('package description does not promise universal savings or compatibility', () => {
    const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
    expect(pkg.description).not.toMatch(/60-95%|any OpenAI-compatible|Model-agnostic/);
  });
});
