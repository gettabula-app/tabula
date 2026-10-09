import { afterEach, describe, expect, it } from 'vitest';
import { KEY, closeWorlds, sticky, setup } from './ai-run-harness';

// TAB-222: a run with a key of an OpenAI-compatible provider. The key row carries the base URL and the model, and the run hands
// them to the provider; a run used to pass only the kind and the key, so a stored base URL was never used.

afterEach(closeWorlds);

const BASE = 'https://integrate.api.nvidia.com/v1';
const MODEL = 'moonshotai/kimi-k3';

async function ready(stored: { provider?: string; baseUrl?: string | null; model?: string | null }, settings: Record<string, string> = {}) {
  const w = await setup();
  w.enable(settings, KEY, stored);
  const owner = w.person('owner');
  const boardId = w.board(owner);
  sticky(w.docOf(boardId), 's1', 'a note');
  return { w, owner, boardId };
}

const generate = (boardId: string) => ({ feature: 'generate', boardId, input: { prompt: 'ideas' } });

describe('a run with a stored OpenAI-compatible key', () => {
  it('gives the provider the stored base URL and model, untrusted, and asks it for that model', async () => {
    const { w, owner, boardId } = await ready({ provider: 'openai-compatible', baseUrl: BASE, model: MODEL }, { model: 'claude-haiku-5-5' });
    const res = await w.run(owner, generate(boardId));
    expect(res.status).toBe(200);
    expect(res.events.map((e) => e.event)).toContain('result');
    expect(w.madeWith).toEqual([{ kind: 'openai-compatible', apiKey: KEY, baseUrl: BASE, model: MODEL, trusted: false }]);
    // the workspace's Anthropic model setting does not pick the model of a key that names its own
    expect(w.calls[0].model).toBe(MODEL);
    expect(w.audits()[0].detail.model).toBe(MODEL);
  });

  it('keeps using the workspace model for an Anthropic key, with no base URL', async () => {
    const { w, owner, boardId } = await ready({}, { model: 'claude-haiku-5-5' });
    await w.run(owner, generate(boardId));
    expect(w.madeWith).toEqual([{ kind: 'anthropic', apiKey: KEY, baseUrl: null, model: null, trusted: false }]);
    expect(w.calls[0].model).toBe('claude-haiku-5-5');
  });

  it('shows a person with their own OpenAI-compatible key that key, and the workspace key to everyone else', async () => {
    const { w, owner, boardId } = await ready({ provider: 'openai-compatible', baseUrl: BASE, model: MODEL }, { personalKeys: '1' });
    w.directory.saveAiKey({ ring: w.ring, scope: 'user', userId: owner.user.id, provider: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta/llama-4', apiKey: `${KEY}-mine`, createdBy: owner.user.id });
    await w.run(owner, generate(boardId));
    expect(w.madeWith[0]).toMatchObject({ baseUrl: 'https://openrouter.ai/api/v1', model: 'meta/llama-4', apiKey: `${KEY}-mine`, trusted: false });
    expect(w.calls[0].model).toBe('meta/llama-4');
  });

  it('never lets the stored address be trusted: only the operator environment sets that', async () => {
    const { w, owner, boardId } = await ready({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', model: MODEL });
    await w.run(owner, generate(boardId));
    expect(w.madeWith[0]).toMatchObject({ baseUrl: 'http://127.0.0.1:9/v1', trusted: false });
  });
});
