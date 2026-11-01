// server/lib/llm.ts — calls to a Claude model behind a Unity Gateway model service (MODEL_SERVICE,
// bound in app.yaml) on the gateway's native Anthropic Messages path. completeStream() feeds the
// e-mail copilot's live rewrite; the first draft of each e-mail is a template (server/app/agent.ts).
import { createWorkspaceClient } from '@databricks/appkit';
import { parseSse, textDelta } from './sse';

const PATH = '/ai-gateway/anthropic/v1/messages';
let client: ReturnType<typeof createWorkspaceClient> | undefined;

export function modelService(): string | null {
  return process.env.MODEL_SERVICE?.trim() || null;
}

/** Streams one reply, handing each text delta to onText; resolves with the whole text. */
export async function completeStream(
  system: string,
  user: string,
  onText: (text: string) => void,
  signal?: AbortSignal,
  timeoutMs = 30_000
): Promise<string> {
  const model = modelService();
  if (!model) throw new Error('MODEL_SERVICE is not set');
  client ??= createWorkspaceClient();
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  // A listener added after the caller already aborted never fires, so check first.
  if (signal?.aborted) ctrl.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await client.request({
      method: 'POST',
      path: PATH,
      headers: new Headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        stream: true,
        // Claude Haiku 5.5 rejects `temperature`, so it is never sent.
        thinking: { type: 'disabled' },
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: ctrl.signal,
    });
    if (!response.ok)
      throw new Error(`Model service returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
    if (!response.body) throw new Error('Model response has no body');
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let rest = '';
    let out = '';
    let stopReason: string | null = null;
    let finished = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const parsed = parseSse(rest + decoder.decode(value, { stream: true }));
      rest = parsed.rest;
      for (const ev of parsed.events) {
        if (ev.type === 'message_stop') finished = true;
        if (ev.type === 'message_delta')
          stopReason = (ev.delta as { stop_reason?: string } | undefined)?.stop_reason ?? stopReason;
        const text = textDelta(ev);
        if (!text) continue;
        out += text;
        onText(text);
      }
    }
    if (ctrl.signal.aborted) throw new Error('Model call aborted');
    // A clean EOF without message_stop (dropped proxy) or a max_tokens cut would pass off a partial e-mail.
    if (!finished || stopReason === 'max_tokens')
      throw new Error(`Model stream ended early (${stopReason ?? 'no message_stop'})`);
    return out;
  } catch (err) {
    // Drop the upstream connection too, or an in-stream error event leaves the gateway socket open.
    ctrl.abort();
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
