import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isVisualization, VISUALIZATION_LIMITS, type Visualization } from '../shared/ai-visualization';
import { FEATURE_SPECS, InputError, InvalidProposal, buildContent, parseInput, validateVisualization } from '../server/ai/features.mjs';
import { KEY, canary, closeWorlds, deferred, fenced, setup, sticky, until } from './ai-run-harness';

const visual = (extra: Record<string, unknown> = {}): Visualization => ({
  title: 'A visual explanation',
  description: 'A self-contained explanation of the notes.',
  initialHeight: 400,
  css: '.value { color: #18212B; }',
  html: '<p class="value" id="value">10</p><button id="increase">Increase</button>',
  jsFunctions: 'function init() { document.getElementById("increase").onclick = () => { document.getElementById("value").textContent = "11"; }; }',
  jsExpressions: ['init();'],
  ...extra,
});
const request = (boardId: string, extra: Record<string, unknown> = {}) => ({ feature: 'visualise', boardId, input: { prompt: 'Explain these notes visually' }, ...extra });

afterEach(closeWorlds);

async function ready(settings: Record<string, string> = {}, stored: { provider?: string; baseUrl?: string | null; model?: string | null } = {}) {
  const w = await setup();
  w.enable(settings, KEY, stored);
  w.state.answer = visual();
  const owner = w.person('owner');
  const boardId = w.board(owner);
  sticky(w.docOf(boardId), 'public', 'A public note');
  return { w, owner, boardId };
}

describe('bounded visualization data', () => {
  it('accepts static and interactive visuals without rewriting their code', () => {
    const artifact = visual();
    expect(isVisualization(artifact)).toBe(true);
    expect(validateVisualization(artifact)).toEqual(artifact);
    expect(isVisualization(visual({ jsFunctions: '', jsExpressions: [], css: '', description: '' }))).toBe(true);
    expect(isVisualization(visual({ initialHeight: VISUALIZATION_LIMITS.heightMin }))).toBe(true);
    expect(isVisualization(visual({ initialHeight: VISUALIZATION_LIMITS.heightMax }))).toBe(true);
    expect(isVisualization(visual({
      title: 'x'.repeat(VISUALIZATION_LIMITS.title), description: 'x'.repeat(VISUALIZATION_LIMITS.description),
      css: 'x'.repeat(VISUALIZATION_LIMITS.css), html: 'x'.repeat(VISUALIZATION_LIMITS.html),
      jsFunctions: 'x'.repeat(VISUALIZATION_LIMITS.js), jsExpressions: [],
    }))).toBe(true);
  });

  it.each([
    ['null', null], ['an array', []], ['unknown fields', visual({ kind: 'visual' })],
    ['blank title', visual({ title: '  ' })], ['oversized title', visual({ title: 'x'.repeat(VISUALIZATION_LIMITS.title + 1) })],
    ['oversized description', visual({ description: 'x'.repeat(VISUALIZATION_LIMITS.description + 1) })],
    ['fractional height', visual({ initialHeight: 400.5 })], ['nonfinite height', visual({ initialHeight: Infinity })],
    ['height below minimum', visual({ initialHeight: VISUALIZATION_LIMITS.heightMin - 1 })],
    ['height above maximum', visual({ initialHeight: VISUALIZATION_LIMITS.heightMax + 1 })],
    ['blank HTML', visual({ html: ' \n ' })], ['oversized HTML', visual({ html: 'x'.repeat(VISUALIZATION_LIMITS.html + 1) })],
    ['oversized CSS', visual({ css: 'x'.repeat(VISUALIZATION_LIMITS.css + 1) })],
    ['JS functions of the wrong type', visual({ jsFunctions: [] })], ['JS expressions of the wrong type', visual({ jsExpressions: '' })],
    ['JS expression of the wrong type', visual({ jsExpressions: [1] })],
    ['too many JS expressions', visual({ jsExpressions: Array(VISUALIZATION_LIMITS.expressions + 1).fill('') })],
    ['oversized JS functions', visual({ jsFunctions: 'x'.repeat(VISUALIZATION_LIMITS.js + 1) })],
    ['aggregate JS over the cap', visual({ jsFunctions: 'x'.repeat(VISUALIZATION_LIMITS.js), jsExpressions: ['x'] })],
  ])('refuses %s', (_label, value) => {
    expect(isVisualization(value)).toBe(false);
    expect(() => validateVisualization(value)).toThrow(InvalidProposal);
  });

  it('requires every field as its own property', () => {
    for (const field of Object.keys(visual())) {
      const value = { ...visual() } as Record<string, unknown>;
      delete value[field];
      expect(isVisualization(value)).toBe(false);
    }
    expect(isVisualization(Object.create(visual()))).toBe(false);
  });

  it('requires a prompt, accepts the existing scope, and refuses proposal-only fields', () => {
    expect(parseInput('visualise', { prompt: '  Explain visually  ', selection: ['public'] })).toMatchObject({ prompt: 'Explain visually', selection: ['public'] });
    expect(parseInput('visualise', { prompt: 'x', frameId: 'frame' })).toMatchObject({ frameId: 'frame' });
    for (const input of [{}, { prompt: ' ' }, { prompt: 'x', count: 10 }, { prompt: 'x', type: 'retro' }, { prompt: 'x', selection: ['public'], frameId: 'frame' }]) {
      expect(() => parseInput('visualise', input)).toThrow(InputError);
    }
    const content = buildContent('visualise', parseInput('visualise', { prompt: 'Explain visually' }), 'FENCED_BOARD');
    expect(content).toContain("FENCED_BOARD\n\nThe person's request");
    expect(content).toContain('Task: create a self-contained visualization.\nRequest:\nExplain visually');
  });
});

describe('visualization runs through the existing relay', () => {
  it('uses the configured provider, fenced context, limits and audit without a live proposal or board write', async () => {
    const { w, owner, boardId } = await ready({ model: 'claude-haiku-5-5' }, {
      provider: 'openai-compatible', baseUrl: 'https://models.example.test/v1', model: 'workspace-model',
    });
    const secret = canary('withheld-note');
    sticky(w.docOf(boardId), 'private', secret, { privateStep: 'step1' });
    const before = Y.encodeStateAsUpdate(w.docOf(boardId));
    const start = vi.spyOn(w.live, 'start');
    const readyRun = vi.spyOn(w.live, 'ready');
    const fail = vi.spyOn(w.live, 'fail');
    const res = await w.run(owner, request(boardId, { input: { prompt: 'Explain visually', selection: ['public', 'private'] } }));

    expect(res.status).toBe(200);
    expect(res.events.at(-1)).toEqual({
      event: 'result', data: { visualization: visual(), cut: false, usage: {
        model: 'workspace-model', inputTokens: 1200, outputTokens: 340, cacheReadTokens: 1000, cacheWriteTokens: 0,
      } },
    });
    expect(res.events.filter((e) => e.event === 'progress').every((e) => !Object.hasOwn(e.data, 'runId'))).toBe(true);
    expect(w.madeWith).toEqual([{ kind: 'openai-compatible', apiKey: KEY, baseUrl: 'https://models.example.test/v1', model: 'workspace-model', trusted: false }]);
    expect(w.calls[0]).toMatchObject({ model: 'workspace-model', maxTokens: 16000, schema: FEATURE_SPECS.visualise.schema });
    expect(fenced(w.calls[0].content).payload.objects.map((o: { id: string }) => o.id)).toEqual(['public']);
    expect(w.calls[0].content).not.toContain(secret);
    expect(Y.encodeStateAsUpdate(w.docOf(boardId))).toEqual(before);
    expect(start).not.toHaveBeenCalled();
    expect(readyRun).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(w.audits()).toMatchObject([{ action: 'ai.visualise', detail: { model: 'workspace-model', keySource: 'workspace', outcome: 'ok', counts: { proposed: 0 } } }]);
    const metadata = JSON.stringify([w.audits(), w.logged]);
    for (const text of [KEY, secret, 'Explain visually', visual().html]) expect(metadata).not.toContain(text);
  });

  it('requires authentication, AI enablement, editing rights, and an enabled feature before calling the provider', async () => {
    const { w, owner, boardId } = await ready({ features: JSON.stringify(['generate', 'summarise', 'cluster']) });
    expect((await w.run(null, request(boardId))).status).toBe(401);
    expect((await w.run(owner, request(boardId), { headers: { 'x-tabula': '0' } })).json.error).toBe('csrf');
    expect((await w.run(owner, request(boardId))).json.error).toBe('ai_feature_disabled');
    w.directory.setSetting('ai.features', JSON.stringify(['visualise']));
    w.directory.setSetting('ai.enabled', '0');
    expect((await w.run(owner, request(boardId))).json.error).toBe('ai_disabled');
    w.directory.setSetting('ai.enabled', '1');
    const viewer = w.person('member');
    w.share(boardId, viewer, 'viewer');
    expect((await w.run(viewer, request(boardId))).json.error).toBe('forbidden');
    w.state.readOnly = true;
    expect((await w.run(owner, request(boardId))).json.error).toBe('read_only');
    w.state.readOnly = false;
    expect((await w.run(owner, request(boardId, { private: true }))).json.error).toBe('bad_request');
    expect(w.calls).toHaveLength(0);
  });

  it('rejects oversized provider output without returning code or starting a live board run', async () => {
    const { w, owner, boardId } = await ready();
    const secret = canary('invalid-provider-code');
    w.state.answer = visual({ jsFunctions: secret + 'x'.repeat(VISUALIZATION_LIMITS.js) });
    const start = vi.spyOn(w.live, 'start');
    const res = await w.run(owner, request(boardId));
    expect(res.events.filter((e) => e.event === 'result')).toEqual([]);
    expect(res.events.at(-1)?.data.error).toBe('ai_invalid_proposal');
    expect(JSON.stringify([res.text, w.audits(), w.logged])).not.toContain(secret);
    expect(w.audits()[0].detail).toMatchObject({ outcome: 'ai_invalid_proposal', counts: { proposed: 0 } });
    expect(start).not.toHaveBeenCalled();
  });

  it('rechecks permissions before returning an artifact after a provider call', async () => {
    const { w, owner, boardId } = await ready();
    const finish = deferred();
    w.state.script = async function* () {
      await finish.promise;
      yield { type: 'result', value: visual(), usage: {} };
    };
    const pending = w.run(owner, request(boardId));
    await until(() => w.calls.length === 1);
    w.directory.setSetting('ai.enabled', '0');
    finish.resolve();
    const res = await pending;
    expect(res.events.at(-1)?.data.error).toBe('forbidden');
    expect(res.events.filter((e) => e.event === 'result')).toEqual([]);
  });

  it('uses the existing per-person hourly limit', async () => {
    const { w, owner, boardId } = await ready({ 'limits.perPersonHour': '1' });
    expect((await w.run(owner, request(boardId))).status).toBe(200);
    const limited = await w.run(owner, request(boardId));
    expect(limited.status).toBe(429);
    expect(limited.json.error).toBe('rate_limited');
    expect(w.calls).toHaveLength(1);
  });

  it('uses hosted credits when no key is configured', async () => {
    const proxyToken = canary('proxy-token');
    const w = await setup({ aiCredits: true, env: {
      TABULA_CLOUD_TOKEN: 'c'.repeat(32), TABULA_CLOUD_URL: 'https://cloud.example.test',
      TABULA_CLOUD_WORKSPACE_ID: 'workspace-1', TABULA_AI_PROXY_URL: 'https://cloud.example.test/ai/v1/workspace-1',
      TABULA_AI_PROXY_TOKEN: proxyToken,
    } });
    w.directory.setSetting('ai.enabled', '1');
    w.state.answer = visual();
    const owner = w.person('owner');
    const boardId = w.board(owner);
    const res = await w.run(owner, request(boardId));
    expect(res.events.at(-1)?.data.visualization).toEqual(visual());
    expect(w.madeWith).toMatchObject([{ kind: 'anthropic', apiKey: proxyToken, baseUrl: 'https://cloud.example.test/ai/v1/workspace-1', trusted: true, proxyErrors: true, maxRetries: 0 }]);
    expect(w.audits()[0].detail.keySource).toBe('credits');
    expect(JSON.stringify([res.text, w.audits(), w.logged])).not.toContain(proxyToken);
  });
});
