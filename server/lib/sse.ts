// server/lib/sse.ts — pure parsing for the Anthropic Messages event stream, kept apart from llm.ts so
// it can be unit-tested without a workspace client.

/** Splits a buffer into the parsed `data:` payloads of complete lines; `rest` is the unfinished tail. */
export function parseSse(buffer: string): { events: Record<string, unknown>[]; rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const events: Record<string, unknown>[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    try {
      const data: unknown = JSON.parse(t.slice(5).trim());
      if (data && typeof data === 'object') events.push(data as Record<string, unknown>);
    } catch {
      /* keep-alive or non-JSON payload */
    }
  }
  return { events, rest };
}

/** The text a stream event adds to the reply ('' for anything else); throws on an `error` event. */
export function textDelta(ev: Record<string, unknown>): string {
  if (ev.type === 'error') {
    const e = ev.error as { message?: string } | undefined;
    throw new Error(`Model stream error: ${e?.message ?? 'unknown'}`);
  }
  if (ev.type !== 'content_block_delta') return '';
  const d = ev.delta as { type?: string; text?: string } | undefined;
  return d?.type === 'text_delta' && typeof d.text === 'string' ? d.text : '';
}
