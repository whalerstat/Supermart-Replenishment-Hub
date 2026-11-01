// server/lib/llm.ts — one non-streaming call to a Claude model behind a Unity Gateway model service
// (MODEL_SERVICE, bound in app.yaml) on the gateway's native Anthropic Messages path. Used to draft
// the store manager e-mail; callers fall back to a template when this throws or times out.
import { createWorkspaceClient } from '@databricks/appkit';

const PATH = '/ai-gateway/anthropic/v1/messages';
let client: ReturnType<typeof createWorkspaceClient> | undefined;

export function modelService(): string | null {
  return process.env.MODEL_SERVICE?.trim() || null;
}

export async function complete(system: string, user: string, timeoutMs = 20_000): Promise<string> {
  const model = modelService();
  if (!model) throw new Error('MODEL_SERVICE is not set');
  client ??= createWorkspaceClient();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await client.request({
      method: 'POST',
      path: PATH,
      headers: new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        thinking: { type: 'disabled' },
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: ctrl.signal,
    });
    if (!response.ok)
      throw new Error(`Model service returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const json = (await response.json()) as { content?: { type: string; text?: string }[] };
    const text = (json.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim();
    if (!text) throw new Error('Model returned no text');
    return text;
  } finally {
    clearTimeout(timer);
  }
}
