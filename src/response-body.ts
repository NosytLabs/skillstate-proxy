/** Bound buffered upstream responses; a rejected prefix is never a complete reply. */
export class ResponseLimitError extends Error {
  constructor(maxBytes: number) {
    super(`upstream response exceeded ${maxBytes} bytes`);
    this.name = 'ResponseLimitError';
  }
}

export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('invalid response byte limit');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ResponseLimitError(maxBytes);
      }
      chunks.push(value.slice());
    }
    return Buffer.concat(chunks, size).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}
