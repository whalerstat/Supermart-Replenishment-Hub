import { describe, expect, it } from 'vitest';
import { parseSse, textDelta } from './sse';

const delta = (text: string) =>
  `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`;

describe('parseSse', () => {
  it('returns complete data lines and keeps the unfinished tail', () => {
    const { events, rest } = parseSse(`event: content_block_delta\n${delta('Hi')}\r\n${delta('Ja').slice(0, 20)}`);
    expect(events).toHaveLength(1);
    expect(textDelta(events[0])).toBe('Hi');
    expect(rest).toBe(delta('Ja').slice(0, 20));
  });

  it('reassembles an event split across chunks', () => {
    const line = `${delta('Hello there')}\n`;
    const first = parseSse(line.slice(0, 15));
    expect(first.events).toEqual([]);
    const second = parseSse(first.rest + line.slice(15));
    expect(second.events.map(textDelta)).toEqual(['Hello there']);
    expect(second.rest).toBe('');
  });

  it('skips non-JSON data and comments', () => {
    expect(parseSse(': ping\ndata: [DONE]\n\n').events).toEqual([]);
  });
});

describe('textDelta', () => {
  it('ignores non-text events', () => {
    expect(textDelta({ type: 'message_start' })).toBe('');
    expect(textDelta({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } })).toBe('');
  });

  it('throws on a stream error event', () => {
    expect(() => textDelta({ type: 'error', error: { message: 'overloaded' } })).toThrow('overloaded');
  });
});
