import { describe, expect, it } from 'vitest';
import type { AiProposal } from '../src/ai-apply';
import type { AiFeature } from '../src/api';
import {
  CHIPS, HISTORY_MAX, NO_FACTS, SEND_MAX, addedMessage, aiTop, armedAfter, arrowPos, buildRunBody, canWalkHistory, chipState, clampPos,
  contextAfterSelection, contextIds, contextLabel, contextMenu, createSseParser, disclosure, dockBottom, dragPos, errorPlain, errorView,
  estimateFor, estimateTokens, formatExact, formatPos, formatTokens, formatWait, isAdminRole, modelChipText, modelShort, nearestIds,
  parseAiEvent, parseHistory, parsePos, placeholderFor, previewLine, promptSent, pushHistory, rateSpoken, rateText, resolveAiRun, runAi,
  runTarget, runTip, runningText, sendsText, serializeHistory, settledMessage, stepHistory, thisRunText, toggleArmed, waitOf,
  type AiOutcome, type Facts, type SseMessage,
} from '../src/ai-bar-logic';
import { parseRequest } from '../server/ai/run.mjs';

// docs/ai-toolbar.md. The pure rules and text of the AI bar: context, chips and arming, the disclosure line, the estimate, the
// request, the stream, errors, history, dock and drag, and the toasts.

const ALL: AiFeature[] = ['generate', 'summarise', 'cluster'];
const facts = (extra: Partial<Facts> = {}): Facts => ({ ...NO_FACTS, ...extra });
const sel = (n: number) => facts({ selected: n, selectedStickies: n });
const BOARD = 'abc_123';

const create = (n: number, frame?: string): AiProposal => ({ kind: 'create', objects: Array.from({ length: n }, (_, i) => ({ text: `n${i}` })), ...(frame ? { frame: { title: frame } } : {}) });
const group = (...sizes: number[]): AiProposal => ({ kind: 'group', groups: sizes.map((n, g) => ({ title: `G${g}`, ids: Array.from({ length: n }, (_, i) => `s${g}-${i}`) })) });

describe('context', () => {
  it('switches to the selection when something is selected, and to the visible area when it is cleared', () => {
    expect(contextAfterSelection('view', 3)).toBe('selection');
    expect(contextAfterSelection('board', 1)).toBe('selection');
    expect(contextAfterSelection('none', 2)).toBe('selection');
    expect(contextAfterSelection('selection', 0)).toBe('view');
  });

  it('keeps a choice made in the menu when the selection is cleared', () => {
    expect(contextAfterSelection('board', 0)).toBe('board');
    expect(contextAfterSelection('none', 0)).toBe('none');
    expect(contextAfterSelection('view', 0)).toBe('view');
  });

  it('labels the pill with a count, singular and plural, and items when the selection holds more than stickies', () => {
    expect(contextLabel('selection', sel(3))).toBe('3 stickies');
    expect(contextLabel('selection', sel(1))).toBe('1 sticky');
    expect(contextLabel('selection', facts({ selected: 3, selectedStickies: 2 }))).toBe('3 items');
    expect(contextLabel('selection', facts({ selected: 1, selectedStickies: 0 }))).toBe('1 item');
    expect(contextLabel('view', sel(3))).toBe('Visible area');
    expect(contextLabel('board', sel(3))).toBe('Whole board');
    expect(contextLabel('none', sel(3))).toBe('Prompt only');
  });

  it('lists the menu with counts, and disables the selection when nothing is selected', () => {
    const items = contextMenu(facts({ selected: 3, selectedStickies: 3, inView: 23, onBoard: 42 }));
    expect(items.map((i) => [i.id, i.label, i.hint, i.disabled])).toEqual([
      ['selection', '3 selected stickies', '', false],
      ['view', 'Visible area', '23 stickies', false],
      ['board', 'Whole board', '42 stickies', false],
      ['none', 'Prompt only', 'No board content', false],
    ]);
    const empty = contextMenu(facts({ inView: 1, onBoard: 1 }));
    expect(empty[0]).toMatchObject({ label: 'Selection', hint: 'Nothing selected', disabled: true });
    expect(empty[1].hint).toBe('1 sticky');
    expect(contextMenu(facts({ selected: 3, selectedStickies: 2 }))[0].label).toBe('3 selected items');
  });
});

describe('chips', () => {
  it('lists Summarise, Cluster and Generate ideas, in that order', () => {
    expect(CHIPS.map((c) => c.label)).toEqual(['Summarise', 'Cluster', 'Generate ideas']);
  });

  it('needs two stickies in the context to summarise, with a reason for each way it fails', () => {
    expect(chipState('summarise', 'selection', sel(2), ALL)).toEqual({ enabled: true, reason: null });
    expect(chipState('summarise', 'selection', sel(1), ALL).reason).toBe('Select 2 or more stickies to summarise');
    expect(chipState('summarise', 'none', sel(5), ALL).reason).toBe('Choose what to summarise: a selection, the visible area or the whole board');
    expect(chipState('summarise', 'view', facts({ inView: 23 }), ALL).enabled).toBe(true);
    expect(chipState('summarise', 'view', facts({ inView: 1 }), ALL).enabled).toBe(false);
    expect(chipState('summarise', 'board', facts({ onBoard: 42 }), ALL).enabled).toBe(true);
    expect(chipState('summarise', 'board', facts({ onBoard: 0 }), ALL).enabled).toBe(false);
  });

  it('needs a selection of 2 to 200 stickies to cluster', () => {
    expect(chipState('cluster', 'selection', sel(2), ALL).enabled).toBe(true);
    expect(chipState('cluster', 'selection', sel(200), ALL).enabled).toBe(true);
    expect(chipState('cluster', 'selection', sel(1), ALL).reason).toBe('Select 2 or more stickies to cluster');
    expect(chipState('cluster', 'selection', sel(201), ALL).reason).toBe('Select 200 stickies or fewer to cluster');
    expect(chipState('cluster', 'view', facts({ inView: 30 }), ALL).reason).toBe('Select 2 or more stickies to cluster');
    expect(chipState('cluster', 'board', facts({ onBoard: 30 }), ALL).enabled).toBe(false);
    expect(chipState('cluster', 'selection', facts({ selected: 4, selectedStickies: 1 }), ALL).enabled).toBe(false);
  });

  it('never disables Generate ideas for lack of context', () => {
    for (const ctx of ['selection', 'view', 'board', 'none'] as const) expect(chipState('generate', ctx, NO_FACTS, ALL).enabled).toBe(true);
  });

  it('disables a feature the workspace turned off, with a tooltip', () => {
    const only = (...f: AiFeature[]) => f;
    expect(chipState('summarise', 'board', facts({ onBoard: 9 }), only('generate'))).toEqual({ enabled: false, reason: 'Turned off for this workspace' });
    expect(chipState('generate', 'none', NO_FACTS, only('summarise')).enabled).toBe(false);
  });
});

describe('arming', () => {
  it('arms a chip, and a second click on it disarms it', () => {
    expect(toggleArmed(null, 'summarise', 'board', facts({ onBoard: 5 }), ALL)).toBe('summarise');
    expect(toggleArmed('summarise', 'summarise', 'board', facts({ onBoard: 5 }), ALL)).toBeNull();
  });

  it('has one armed chip at a time', () => {
    expect(toggleArmed('summarise', 'generate', 'board', facts({ onBoard: 5 }), ALL)).toBe('generate');
  });

  it('ignores a click on a disabled chip', () => {
    expect(toggleArmed(null, 'cluster', 'view', facts({ inView: 5 }), ALL)).toBeNull();
    expect(toggleArmed('generate', 'cluster', 'view', facts({ inView: 5 }), ALL)).toBe('generate');
  });

  it('disarms when the action is no longer available', () => {
    expect(armedAfter('cluster', 'selection', sel(9), ALL)).toBe('cluster');
    expect(armedAfter('cluster', 'selection', sel(1), ALL)).toBeNull();
    expect(armedAfter('cluster', 'view', sel(9), ALL)).toBeNull();
    expect(armedAfter('summarise', 'none', sel(9), ALL)).toBeNull();
    expect(armedAfter('generate', 'none', NO_FACTS, ALL)).toBe('generate');
    expect(armedAfter(null, 'none', NO_FACTS, ALL)).toBeNull();
  });

  it('runs the armed action, else Generate when a prompt is typed', () => {
    const f = facts({ onBoard: 5 });
    expect(runTarget('summarise', '', 'board', f, ALL)).toBe('summarise');
    expect(runTarget('summarise', 'as action items', 'board', f, ALL)).toBe('summarise');
    expect(runTarget(null, 'ten risks', 'board', f, ALL)).toBe('generate');
    expect(runTarget('generate', 'ten risks', 'board', f, ALL)).toBe('generate');
  });

  it('has nothing to run without an armed action or a prompt, and Generate always needs a prompt', () => {
    expect(runTarget(null, '', 'board', facts({ onBoard: 5 }), ALL)).toBeNull();
    expect(runTarget(null, '   ', 'board', facts({ onBoard: 5 }), ALL)).toBeNull();
    expect(runTarget('generate', '', 'none', NO_FACTS, ALL)).toBeNull();
  });

  it('does not run an action whose chip is disabled', () => {
    expect(runTarget('cluster', '', 'view', facts({ inView: 5 }), ALL)).toBeNull();
    expect(runTarget(null, 'ten risks', 'none', NO_FACTS, ['summarise'])).toBeNull();
  });

  it('gives Run a tooltip that names the action, or says what is missing', () => {
    expect(runTip('summarise')).toBe('Summarise');
    expect(runTip('cluster')).toBe('Cluster');
    expect(runTip('generate')).toBe('Generate sticky notes');
    expect(runTip(null)).toBe('Type what to generate, or pick an action above');
  });

  it('changes the placeholder with the armed action', () => {
    expect(placeholderFor(null)).toBe('Generate sticky notes about…');
    expect(placeholderFor('generate')).toBe('Generate sticky notes about…');
    expect(placeholderFor('summarise')).toBe('Optional instruction…');
    expect(placeholderFor('cluster')).not.toBe('Optional instruction…');
  });

  it('takes the prompt along for every action but Cluster, which the relay takes none for', () => {
    expect(promptSent('generate')).toBe(true);
    expect(promptSent('summarise')).toBe(true);
    expect(promptSent(null)).toBe(true);
    expect(promptSent('cluster')).toBe(false);
  });

  it('says what a run is doing', () => {
    expect(runningText('summarise', 'board', facts({ onBoard: 42 }))).toBe('Summarising 42 stickies…');
    expect(runningText('cluster', 'selection', sel(12))).toBe('Clustering 12 stickies…');
    expect(runningText('summarise', 'selection', facts({ selected: 3, selectedStickies: 2 }))).toBe('Summarising 3 items…');
    expect(runningText('summarise', 'view', facts({ inView: 1 }))).toBe('Summarising 1 sticky…');
    expect(runningText('generate', 'board', facts({ onBoard: 42 }))).toBe('Generating ideas…');
    expect(runningText('summarise', 'none', NO_FACTS)).toBe('Summarising…');
  });
});

describe('the disclosure line', () => {
  const d = (over: Partial<Parameters<typeof disclosure>[0]> = {}) =>
    disclosure({ ui: 'idle', ctx: 'selection', facts: sel(3), prompt: '', withPrompt: true, keySource: 'workspace', privateRun: false, proposalKind: null, ...over });

  it('says what is sent for each context', () => {
    expect(sendsText('selection', sel(3), '')).toBe('Sends 3 selected stickies to Anthropic');
    expect(sendsText('selection', sel(1), '')).toBe('Sends 1 selected sticky to Anthropic');
    expect(sendsText('selection', facts({ selected: 3, selectedStickies: 1 }), '')).toBe('Sends 3 selected items to Anthropic');
    expect(sendsText('view', facts({ inView: 23 }), '')).toBe('Sends the 23 stickies in view to Anthropic');
    expect(sendsText('board', facts({ onBoard: 42 }), '')).toBe('Sends all 42 stickies to Anthropic');
    expect(sendsText('none', facts({ onBoard: 42 }), '')).toBe('Sends only what you type to Anthropic');
    expect(sendsText('none', NO_FACTS, 'ten risks')).toBe('Sends only your prompt to Anthropic');
  });

  it('adds the prompt before "to Anthropic", except for Prompt only', () => {
    expect(sendsText('selection', sel(3), 'as action items')).toBe('Sends 3 selected stickies and your prompt to Anthropic');
    expect(sendsText('board', facts({ onBoard: 42 }), 'x')).toBe('Sends all 42 stickies and your prompt to Anthropic');
    expect(sendsText('none', NO_FACTS, 'x')).toBe('Sends only your prompt to Anthropic');
    expect(sendsText('selection', sel(3), '   ')).toBe('Sends 3 selected stickies to Anthropic');
  });

  it('leaves the prompt out when the action takes none', () => {
    expect(sendsText('selection', sel(3), 'x', false)).toBe('Sends 3 selected stickies to Anthropic');
  });

  it('shows the capped count when the relay will cut the content', () => {
    expect(sendsText('board', facts({ onBoard: 450 }), '')).toBe('Sends the 400 stickies nearest the middle of the board to Anthropic');
    expect(sendsText('view', facts({ inView: 401 }), '')).toBe('Sends the 400 stickies nearest the middle of the view to Anthropic');
    expect(sendsText('selection', sel(450), '')).toBe('Sends 400 of the 450 selected stickies to Anthropic');
    expect(sendsText('board', facts({ onBoard: 400 }), '')).toBe('Sends all 400 stickies to Anthropic');
  });

  it('sends only the prompt when the context holds nothing', () => {
    expect(sendsText('view', NO_FACTS, 'x')).toBe('Sends only your prompt to Anthropic');
    expect(sendsText('board', NO_FACTS, '')).toBe('Sends only what you type to Anthropic');
  });

  it('names who pays', () => {
    expect(d({ keySource: 'workspace' })[1]).toBe('Uses the workspace key');
    expect(d({ keySource: 'user' })[1]).toBe('Uses your key');
    expect(d({ keySource: 'user', privateRun: true })[1]).toBe('Uses your key · Private run');
    expect(d({ keySource: null })[1]).toBe('No AI key set');
  });

  it('ignores the private switch on a key that cannot run privately', () => {
    expect(d({ keySource: 'workspace', privateRun: true })[1]).toBe('Uses the workspace key');
    expect(d({ ui: 'running', keySource: 'workspace', privateRun: true })[1]).toBe('Esc stops');
  });

  it('says "Esc stops" while running, with "Private run" first on a private run', () => {
    expect(d({ ui: 'running' })).toEqual(['Sends 3 selected stickies to Anthropic', 'Esc stops']);
    expect(d({ ui: 'running', keySource: 'user', privateRun: true })[1]).toBe('Private run · Esc stops');
  });

  it('keeps the sends and key line in an error', () => {
    expect(d({ ui: 'error' })).toEqual(['Sends 3 selected stickies to Anthropic', 'Uses the workspace key']);
  });

  it('says in a preview that nothing is on the board yet, and what Enter does', () => {
    expect(d({ ui: 'preview', proposalKind: 'create' })).toEqual(['Nothing is on the board until you add it', 'Enter adds, Esc discards']);
    expect(d({ ui: 'preview', proposalKind: 'group' })).toEqual(['Nothing is on the board until you add it', 'Enter moves them, Esc discards']);
  });
});

describe('the estimate', () => {
  it('is 1,000 tokens plus 100 per sticky plus a quarter of the prompt characters', () => {
    expect(estimateTokens(0, 0)).toBe(1000);
    expect(estimateTokens(3, 0)).toBe(1300);
    expect(estimateTokens(3, 40)).toBe(1310);
    expect(estimateTokens(10, 2)).toBe(2001);
  });

  it('counts no more than the relay reads', () => {
    expect(estimateTokens(900, 0)).toBe(1000 + 100 * SEND_MAX);
  });

  it('formats with a tilde, in thousands from 1,000', () => {
    expect(formatTokens(1300)).toBe('~1.3k');
    expect(formatTokens(1000)).toBe('~1k');
    expect(formatTokens(2049)).toBe('~2k');
    expect(formatTokens(2050)).toBe('~2.1k');
    expect(formatTokens(41000)).toBe('~41k');
    expect(formatTokens(950)).toBe('~950');
    expect(formatTokens(520)).toBe('~500');
  });

  it('rounds the popover figure to 50 with a thousands separator', () => {
    expect(formatExact(1300)).toBe('1,300');
    expect(formatExact(1310)).toBe('1,300');
    expect(formatExact(1330)).toBe('1,350');
    expect(formatExact(980)).toBe('1,000');
    expect(formatExact(41025)).toBe('41,050');
  });

  it('says in the popover how many tokens go in and what caps the reply', () => {
    expect(thisRunText(1300, 4000)).toBe('About 1,300 tokens go in; the reply is capped at 4,000. An estimate, not a bill.');
    expect(thisRunText(1300, 8000)).toContain('capped at 8,000');
  });

  it('goes by the context and the prompt, and leaves the prompt out for a cluster', () => {
    const base = { armed: null, ctx: 'selection' as const, facts: sel(3), prompt: 'a'.repeat(40) };
    expect(estimateFor(base)).toBe(1310);
    expect(estimateFor({ ...base, armed: 'summarise' })).toBe(1310);
    expect(estimateFor({ ...base, armed: 'cluster' })).toBe(1300);
    expect(estimateFor({ ...base, ctx: 'none' })).toBe(1010);
    expect(estimateFor({ ...base, ctx: 'board', facts: facts({ onBoard: 42 }) })).toBe(5210);
  });
});

describe('the model chip', () => {
  const o = { armed: null, model: 'claude-opus-5-5', ctx: 'selection' as const, facts: sel(3), prompt: '' };

  it('maps the model id to its short name and shows an unknown id as it is', () => {
    expect(modelShort('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelShort('claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(modelShort('claude-haiku-5-5')).toBe('Haiku 5.5');
    expect(modelShort('claude-mystery-9')).toBe('claude-mystery-9');
  });

  it('shows the model and the estimate', () => {
    expect(modelChipText(o)).toBe('Opus 5.5 · ~1.3k tokens');
    expect(modelChipText({ ...o, model: 'claude-sonnet-5-5', ctx: 'board', facts: facts({ onBoard: 42 }) })).toBe('Sonnet 5.5 · ~5.2k tokens');
  });

  it('names the action instead of the model when one is armed', () => {
    expect(modelChipText({ ...o, armed: 'summarise' })).toBe('Summarise · ~1.3k tokens');
    expect(modelChipText({ ...o, armed: 'generate', prompt: 'x'.repeat(400) })).toBe('Generate ideas · ~1.4k tokens');
  });
});

describe('the request body', () => {
  const base = {
    boardId: BOARD, prompt: '', selection: ['a', 'f', 'b'], selectionStickies: ['a', 'b'], view: ['v1', 'v2', 'v3'],
    person: { name: 'Ana', color: '#2F6FED' }, keySource: 'workspace' as const, privateRun: false,
  };

  it('maps a selection to its ids', () => {
    const body = buildRunBody({ ...base, feature: 'summarise', ctx: 'selection' });
    expect(body.input).toEqual({ selection: ['a', 'f', 'b'] });
    expect(body.presence).toEqual({ color: '#2F6FED', name: 'Ana' });
  });

  it('maps the visible area to the ids in view and turns the outline off', () => {
    const body = buildRunBody({ ...base, feature: 'summarise', ctx: 'view' });
    expect(body.input).toEqual({ selection: ['v1', 'v2', 'v3'] });
    expect(body.presence).toEqual({ color: '#2F6FED', name: 'Ana', outline: false });
  });

  it('names no ids for the whole board or a bare prompt', () => {
    expect(buildRunBody({ ...base, feature: 'summarise', ctx: 'board' }).input).toEqual({});
    expect(buildRunBody({ ...base, feature: 'generate', ctx: 'none', prompt: 'ten risks' }).input).toEqual({ prompt: 'ten risks' });
    expect(buildRunBody({ ...base, feature: 'generate', ctx: 'board', prompt: 'ten risks' }).input).toEqual({ prompt: 'ten risks' });
  });

  it('takes a prompt for Generate, and for Summarise only when one is typed', () => {
    expect(buildRunBody({ ...base, feature: 'generate', ctx: 'selection', prompt: '  ten risks  ' }).input).toEqual({ prompt: 'ten risks', selection: ['a', 'f', 'b'] });
    expect(buildRunBody({ ...base, feature: 'summarise', ctx: 'board', prompt: 'as action items' }).input).toEqual({ prompt: 'as action items' });
    expect(buildRunBody({ ...base, feature: 'summarise', ctx: 'board', prompt: '   ' }).input).toEqual({});
  });

  it('sends a cluster the selected stickies only, and no prompt', () => {
    const body = buildRunBody({ ...base, feature: 'cluster', ctx: 'selection', prompt: 'by team' });
    expect(body.input).toEqual({ selection: ['a', 'b'] });
  });

  it('cuts a prompt to the relay\'s limit', () => {
    const body = buildRunBody({ ...base, feature: 'generate', ctx: 'none', prompt: 'x'.repeat(2500) });
    expect((body.input.prompt as string).length).toBe(2000);
  });

  it('sends no more ids than the relay takes', () => {
    const many = Array.from({ length: 500 }, (_, i) => `s${i}`);
    expect((buildRunBody({ ...base, feature: 'summarise', ctx: 'selection', selection: many, selectionStickies: many }).input.selection as string[]).length).toBe(400);
    expect((buildRunBody({ ...base, feature: 'summarise', ctx: 'view', view: many }).input.selection as string[]).length).toBe(400);
    expect((buildRunBody({ ...base, feature: 'cluster', ctx: 'selection', selection: many, selectionStickies: many }).input.selection as string[]).length).toBe(200);
    expect(contextIds({ feature: 'generate', ctx: 'none', selection: many, selectionStickies: many, view: many })).toEqual([]);
  });

  it('is private only on a personal key with the switch on', () => {
    const run = (keySource: 'user' | 'workspace' | null, privateRun: boolean) => buildRunBody({ ...base, feature: 'summarise', ctx: 'board', keySource, privateRun }).private;
    expect(run('user', true)).toBe(true);
    expect(run('user', false)).toBeUndefined();
    expect(run('workspace', true)).toBeUndefined();
    expect(run(null, true)).toBeUndefined();
  });

  it('leaves out a colour that is not #RRGGBB and a blank name, and cuts a long name', () => {
    expect(buildRunBody({ ...base, feature: 'summarise', ctx: 'board', person: { name: '  ', color: 'red' } }).presence).toBeUndefined();
    expect(buildRunBody({ ...base, feature: 'summarise', ctx: 'board', person: { name: 'x'.repeat(60), color: null } }).presence).toEqual({ name: 'x'.repeat(40) });
  });

  it('passes the relay\'s own checks for every feature and context', () => {
    for (const feature of ALL) {
      for (const ctx of ['selection', 'view', 'board', 'none'] as const) {
        if (feature === 'cluster' && ctx !== 'selection') continue;
        for (const prompt of ['', 'ten risks of moving to the cloud']) {
          if (feature === 'generate' && !prompt) continue;
          for (const keySource of ['user', 'workspace'] as const) {
            const body = buildRunBody({ ...base, feature, ctx, prompt, keySource, privateRun: true });
            expect(() => parseRequest(JSON.parse(JSON.stringify(body)))).not.toThrow();
          }
        }
      }
    }
  });

  it('picks the ids nearest the middle first, ties by id', () => {
    const items = [{ id: 'far', x: 100, y: 0 }, { id: 'b', x: 1, y: 0 }, { id: 'a', x: 0, y: 1 }, { id: 'mid', x: 10, y: 0 }];
    expect(nearestIds(items, { x: 0, y: 0 }, 3)).toEqual(['a', 'b', 'mid']);
    expect(nearestIds(items, { x: 0, y: 0 })).toEqual(['a', 'b', 'mid', 'far']);
  });
});

describe('the stream parser', () => {
  const collect = () => {
    const out: SseMessage[] = [];
    return { out, parser: createSseParser((m) => out.push(m)) };
  };
  const text = 'event: progress\ndata: {"n":0,"runId":"r1"}\n\nevent: result\ndata: {"runId":"r1","proposal":{"kind":"create","objects":[{"text":"a"}]},"cut":false}\n\n';

  it('reads events from one chunk, several to a chunk', () => {
    const { out, parser } = collect();
    parser.push(text);
    expect(out.map((m) => m.event)).toEqual(['progress', 'result']);
    expect(JSON.parse(out[0].data)).toEqual({ n: 0, runId: 'r1' });
  });

  it('reads the same events however the text is cut', () => {
    const { out: whole, parser } = collect();
    parser.push(text);
    for (let cut = 1; cut < text.length; cut++) {
      const { out, parser: p } = collect();
      p.push(text.slice(0, cut));
      p.push(text.slice(cut));
      expect(out).toEqual(whole);
    }
  });

  it('reads the events when the text arrives one character at a time', () => {
    const { out, parser } = collect();
    for (const ch of text) parser.push(ch);
    expect(out.map((m) => m.event)).toEqual(['progress', 'result']);
  });

  it('does not end an event before its blank line', () => {
    const { out, parser } = collect();
    parser.push('event: progress\ndata: {"n":0}\n');
    expect(out).toEqual([]);
    parser.push('\n');
    expect(out).toHaveLength(1);
  });

  it('accepts \\r\\n and \\r line ends, also split between the \\r and the \\n', () => {
    for (const eol of ['\r\n', '\r']) {
      const { out, parser } = collect();
      parser.push(`event: progress${eol}data: {"n":1}${eol}${eol}`);
      // a \r at the very end may start a \r\n, so the last one waits for the next chunk or the end of the stream
      parser.end();
      expect(out).toEqual([{ event: 'progress', data: '{"n":1}' }]);
    }
    const { out, parser } = collect();
    parser.push('event: progress\r');
    parser.push('\ndata: {"n":1}\r');
    parser.push('\n\r');
    parser.push('\n');
    expect(out).toEqual([{ event: 'progress', data: '{"n":1}' }]);
  });

  it('joins several data lines, ignores comments and other fields, and takes one leading space only', () => {
    const { out, parser } = collect();
    parser.push(': keep-alive\nid: 7\nretry: 100\ndata:  a\ndata: b\n\n');
    expect(out).toEqual([{ event: 'message', data: ' a\nb' }]);
  });

  it('does not call an event with no data', () => {
    const { out, parser } = collect();
    parser.push('event: progress\n\n\n\n: ping\n\n');
    expect(out).toEqual([]);
  });

  it('flushes a final event that lacks its blank line when the stream ends', () => {
    const { out, parser } = collect();
    parser.push('event: error\ndata: {"error":"internal"}');
    expect(out).toEqual([]);
    parser.end();
    expect(out).toHaveLength(1);
  });

  it('reads progress, result and error events, and drops what it cannot read', () => {
    const msg = (event: string, data: unknown): SseMessage => ({ event, data: typeof data === 'string' ? data : JSON.stringify(data) });
    expect(parseAiEvent(msg('progress', { n: 0, runId: 'r1' }))).toEqual({ type: 'progress', n: 0, runId: 'r1' });
    expect(parseAiEvent(msg('progress', { n: 3 }))).toEqual({ type: 'progress', n: 3, runId: null });
    const proposal = create(2);
    expect(parseAiEvent(msg('result', { runId: 'r1', proposal, cut: true, usage: {} }))).toEqual({ type: 'result', runId: 'r1', proposal, cut: true });
    expect(parseAiEvent(msg('error', { error: 'ai_refused', message: 'x' }))).toEqual({ type: 'error', code: 'ai_refused', message: 'x' });
    expect(parseAiEvent(msg('error', {}))).toEqual({ type: 'error', code: 'internal', message: null });
    expect(parseAiEvent(msg('result', { runId: 'r1', proposal: { kind: 'create', objects: [] } }))).toBeNull();
    expect(parseAiEvent(msg('result', { runId: 'r1', proposal: { kind: 'other' } }))).toBeNull();
    expect(parseAiEvent(msg('progress', 'not json'))).toBeNull();
    expect(parseAiEvent(msg('mystery', {}))).toBeNull();
  });
});

describe('runAi and resolveAiRun', () => {
  const body = buildRunBody({
    feature: 'generate', boardId: BOARD, ctx: 'none', prompt: 'ten risks', selection: [], selectionStickies: [], view: [], person: {}, keySource: 'workspace', privateRun: false,
  });
  const sse = (...parts: string[]) =>
    new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
  const result = 'event: result\ndata: {"runId":"r1","proposal":{"kind":"create","objects":[{"text":"a"}]},"cut":false,"usage":{}}\n\n';
  type Call = { url: string; init: RequestInit };
  const fake = (res: () => Response | Promise<Response>) => {
    const calls: Call[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return res();
    }) as unknown as typeof fetch;
    return { fn, calls };
  };

  it('posts the body with the CSRF header and reads the proposal, telling the first run id as soon as it arrives', async () => {
    const f = fake(() => sse('event: progress\ndata: {"n":0,"runId":"r1"}\n\n', 'event: progress\ndata: {"n":1}\n\n', result));
    const ids: string[] = [];
    const out = await runAi(f.fn, body, { onRunId: (id) => ids.push(id) });
    expect(out).toEqual({ ok: true, runId: 'r1', proposal: { kind: 'create', objects: [{ text: 'a' }] }, cut: false });
    expect(ids).toEqual(['r1']);
    expect(f.calls[0].url).toBe('/api/ai/run');
    expect(f.calls[0].init.method).toBe('POST');
    expect((f.calls[0].init.headers as Record<string, string>)['x-tabula']).toBe('1');
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual(body);
  });

  it('reads a stream cut in the middle of an event, and of a multibyte character', async () => {
    const bytes = new TextEncoder().encode(result.replace('"a"', '"é"'));
    const at = bytes.indexOf(0xc3) + 1;
    const res = new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, at)); c.enqueue(bytes.slice(at)); c.close(); } }), { status: 200 });
    const out = await runAi(fake(() => res).fn, body);
    expect(out).toMatchObject({ ok: true, proposal: { objects: [{ text: 'é' }] } });
  });

  it('turns an error event into a failure', async () => {
    const out = await runAi(fake(() => sse('event: progress\ndata: {"n":0,"runId":"r1"}\n\nevent: error\ndata: {"error":"ai_refused","message":"No"}\n\n')).fn, body);
    expect(out).toEqual({ ok: false, failure: { code: 'ai_refused', status: 200, message: 'No', retryAfter: null } });
  });

  it('fails when the stream ends without a result', async () => {
    const out = (await runAi(fake(() => sse('event: progress\ndata: {"n":0}\n\n')).fn, body)) as Extract<AiOutcome, { ok: false }>;
    expect(out.failure.code).toBe('internal');
  });

  it('reads an error before the stream, with its retry-after', async () => {
    const out = await runAi(fake(() => json(429, { error: 'rate_limited', message: 'Wait' }, { 'retry-after': '40' })).fn, body);
    expect(out).toEqual({ ok: false, failure: { code: 'rate_limited', status: 429, message: 'Wait', retryAfter: 40 } });
    const missing = (await runAi(fake(() => json(429, { error: 'rate_limited' })).fn, body)) as Extract<AiOutcome, { ok: false }>;
    expect(missing.failure.retryAfter).toBeNull();
  });

  it('names a code from the status when the answer has none', async () => {
    const code = async (status: number) => ((await runAi(fake(() => new Response('<html>', { status })).fn, body)) as Extract<AiOutcome, { ok: false }>).failure.code;
    expect(await code(429)).toBe('rate_limited');
    expect(await code(402)).toBe('read_only');
    expect(await code(502)).toBe('internal');
    expect(await code(418)).toBe('unknown');
  });

  it('reports a failed connection as network, and a closed request as aborted', async () => {
    const down = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    expect(await runAi(down, body)).toMatchObject({ ok: false, failure: { code: 'network' } });
    const stop = new AbortController();
    stop.abort();
    const aborted = (async () => { throw new DOMException('x', 'AbortError'); }) as unknown as typeof fetch;
    expect(await runAi(aborted, body, { signal: stop.signal })).toMatchObject({ ok: false, failure: { code: 'aborted' } });
  });

  it('ends with aborted when Stop closes the stream while it is read', async () => {
    const stop = new AbortController();
    const res = new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('event: progress\ndata: {"n":0,"runId":"r1"}\n\n'));
        stop.signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
      },
    }), { status: 200 });
    const ids: string[] = [];
    const run = runAi(fake(() => res).fn, body, { signal: stop.signal, onRunId: (id) => ids.push(id) });
    setTimeout(() => stop.abort(), 5);
    expect(await run).toMatchObject({ ok: false, failure: { code: 'aborted' } });
    expect(ids).toEqual(['r1']);
  });

  it('resolves: an accept returns the proposal to write', async () => {
    const f = fake(() => json(200, { id: 'r1', action: 'accept', feature: 'generate', proposal: create(2), cut: false }));
    expect(await resolveAiRun(f.fn, 'r1', 'accept')).toEqual({ kind: 'ok', action: 'accept', proposal: create(2) });
    expect(f.calls[0].url).toBe('/api/ai/runs/r1/resolve');
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ action: 'accept' });
    expect((f.calls[0].init.headers as Record<string, string>)['x-tabula']).toBe('1');
  });

  it('resolves: a discard needs no proposal, an accept without one is an error', async () => {
    expect(await resolveAiRun(fake(() => json(200, { id: 'r1', action: 'discard' })).fn, 'r1', 'discard')).toEqual({ kind: 'ok', action: 'discard', proposal: null });
    expect(await resolveAiRun(fake(() => json(200, { id: 'r1', action: 'accept' })).fn, 'r1', 'accept')).toEqual({ kind: 'error' });
  });

  it('resolves: tells who settled it first and how', async () => {
    const lost = json(409, { error: 'ai_run_resolved', message: 'x', action: 'accept', by: { id: 'u2', name: 'Ben' } });
    expect(await resolveAiRun(fake(() => lost).fn, 'r1', 'accept')).toEqual({ kind: 'settled', action: 'accept', by: { id: 'u2', name: 'Ben' } });
    const anon = json(409, { error: 'ai_run_resolved', action: 'expired', by: null });
    expect(await resolveAiRun(fake(() => anon).fn, 'r1', 'discard')).toEqual({ kind: 'settled', action: 'expired', by: null });
  });

  it('resolves: maps the other answers', async () => {
    const kind = async (res: Response) => (await resolveAiRun(fake(() => res).fn, 'r1', 'accept')).kind;
    expect(await kind(json(409, { error: 'ai_run_running' }))).toBe('running');
    expect(await kind(json(404, { error: 'not_found' }))).toBe('gone');
    expect(await kind(json(403, { error: 'forbidden' }))).toBe('forbidden');
    expect(await kind(json(402, { error: 'read_only' }))).toBe('read_only');
    expect(await kind(json(500, { error: 'internal' }))).toBe('error');
    const down = (async () => { throw new TypeError('x'); }) as unknown as typeof fetch;
    expect((await resolveAiRun(down, 'r1', 'accept')).kind).toBe('network');
  });
});

describe('errors', () => {
  const view = (code: string, over: Partial<Parameters<typeof errorView>[1]> = {}) => errorView(code, { admin: false, keySource: 'workspace', ...over });

  it('says AI is not set up, with a link for an admin and a note for everyone else', () => {
    for (const code of ['ai_disabled', 'ai_feature_disabled', 'ai_no_key', 'ai_key_unreadable', 'ai_unconfigured']) {
      const admin = view(code, { admin: true });
      expect(admin).toMatchObject({ kind: 'nokey', text: "AI isn't set up for this workspace.", link: { label: 'Set up AI', target: 'admin-ai' }, note: null, retry: false });
      expect(errorPlain(admin)).toBe("AI isn't set up for this workspace. Set up AI");
      expect(view(code)).toMatchObject({ kind: 'nokey', link: null, note: 'Ask a workspace admin.' });
    }
  });

  it('says the key was rejected, with a link for an admin or for a person with their own key', () => {
    expect(errorPlain(view('ai_key_invalid', { admin: true }))).toBe('The AI key was rejected. Check it in AI settings.');
    expect(view('ai_key_invalid', { admin: true }).link?.target).toBe('admin-ai');
    expect(errorPlain(view('ai_key_invalid', { keySource: 'user' }))).toBe('The AI key was rejected. Check it in AI settings.');
    expect(view('ai_key_invalid', { keySource: 'user' }).link?.target).toBe('my-key');
    expect(view('ai_key_invalid', { admin: true, keySource: 'user' }).link?.target).toBe('my-key');
    expect(errorPlain(view('ai_key_invalid'))).toBe('The AI key was rejected. Ask a workspace admin to check it.');
    expect(view('ai_key_invalid').link).toBeNull();
  });

  it('counts down a rate limit from retry-after, 30 seconds when it is missing', () => {
    for (const code of ['rate_limited', 'ai_rate_limited']) {
      expect(view(code, { retryAfter: 40 })).toMatchObject({ kind: 'rate', text: 'Too many requests. Try again in 40 s.', retry: true, wait: 40 });
      expect(view(code)).toMatchObject({ wait: 30, text: 'Too many requests. Try again in 30 s.' });
      expect(view(code, { retryAfter: null }).wait).toBe(30);
    }
    expect(waitOf(0)).toBe(30);
    expect(waitOf(2.2)).toBe(3);
    expect(waitOf(99999)).toBe(3600);
  });

  it('words a countdown for the eye and for a screen reader', () => {
    expect(rateText(40)).toBe('Too many requests. Try again in 40 s.');
    expect(rateText(0)).toBe('Too many requests. You can try again now.');
    expect(rateSpoken(40)).toBe('Too many requests. Try again in 40 seconds.');
    expect(rateSpoken(1)).toBe('Too many requests. Try again in 1 second.');
    expect(rateSpoken(0)).toBe('You can try again now.');
    expect(formatWait(90)).toBe('90 s');
    expect(formatWait(91)).toBe('2 min');
    expect(formatWait(600)).toBe('10 min');
    expect(rateSpoken(600)).toBe('Too many requests. Try again in 10 minutes.');
  });

  it('says the provider is not responding for an unavailable provider, a timeout and an internal error', () => {
    for (const code of ['ai_unavailable', 'ai_timeout', 'internal']) {
      expect(view(code)).toMatchObject({ kind: 'down', text: "Anthropic isn't responding. Try again in a moment.", retry: true });
    }
  });

  it('says a refusal changed nothing and offers Edit request instead of Retry', () => {
    expect(view('ai_refused')).toMatchObject({ kind: 'refused', text: 'The AI declined this request. Nothing was changed.', edit: true, retry: false });
  });

  it('says AI is off while the workspace is read-only, with nothing to retry', () => {
    expect(view('read_only')).toMatchObject({ kind: 'readonly', text: "AI isn't available while this workspace is read-only.", retry: false, edit: false });
  });

  it('says the person is offline, for a failed connection or a missing one', () => {
    expect(view('network')).toMatchObject({ kind: 'offline', text: "You're offline. AI needs a connection.", retry: true, offline: true });
    expect(view('offline').kind).toBe('offline');
  });

  it('shows a bad request\'s fixed message plainly, with nothing to retry', () => {
    expect(view('bad_request', { message: 'There is nothing to summarise here' })).toMatchObject({ kind: 'request', text: 'There is nothing to summarise here', retry: false });
    expect(view('bad_request').text).toBe('The request could not be used.');
  });

  it('says an unusable answer changed nothing, and a changed board needs a new run, both with Retry', () => {
    expect(view('ai_invalid_proposal')).toMatchObject({ text: "The AI's answer could not be used. Nothing was changed.", retry: true });
    expect(view('board_changed')).toMatchObject({ text: 'The board changed while you were looking. Run it again.', retry: true });
  });

  it('never shows a raw code, also for a code it does not know', () => {
    const codes = ['ai_disabled', 'ai_key_invalid', 'rate_limited', 'ai_unavailable', 'ai_refused', 'read_only', 'network', 'ai_invalid_proposal', 'board_changed', 'forbidden', 'unauthenticated', 'weird_code_7'];
    for (const code of codes) {
      for (const admin of [true, false]) {
        const text = errorPlain(view(code, { admin }));
        expect(text).not.toMatch(/[a-z]+_[a-z_0-9]+/);
        expect(text).not.toMatch(/\bai_|\binternal\b|\bunknown\b/);
      }
    }
    expect(view('weird_code_7')).toMatchObject({ kind: 'generic', retry: true });
  });

  it('tells an admin from an owner or admin role only', () => {
    expect(isAdminRole('owner')).toBe(true);
    expect(isAdminRole('admin')).toBe(true);
    expect(isAdminRole('member')).toBe(false);
    expect(isAdminRole('guest')).toBe(false);
    expect(isAdminRole(null)).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
  });
});

describe('the preview and the toasts', () => {
  it('sums up a preview in one line', () => {
    expect(previewLine(create(6, 'Summary'))).toBe('6 stickies in a new frame “Summary”');
    expect(previewLine(create(1, 'Summary'))).toBe('1 sticky in a new frame “Summary”');
    expect(previewLine(create(6))).toBe('6 new stickies');
    expect(previewLine(create(1))).toBe('1 new sticky');
    expect(previewLine(group(4, 3, 2))).toBe('Moves 9 stickies into 3 groups');
    expect(previewLine(group(1, 1))).toBe('Moves 2 stickies into 2 groups');
  });

  it('says what Add did, to be shown with Undo', () => {
    expect(addedMessage(create(6, 'Summary'))).toBe('Added 6 stickies.');
    expect(addedMessage(create(1))).toBe('Added 1 sticky.');
    expect(addedMessage(group(4, 3, 2))).toBe('Moved 9 stickies into 3 groups.');
  });

  it('names who settled a preview first, and how', () => {
    const ben = { id: 'u2', name: 'Ben' };
    expect(settledMessage('accept', ben)).toBe('Ben added your preview.');
    expect(settledMessage('discard', ben)).toBe('Ben discarded your preview.');
    expect(settledMessage('accept', { id: null, name: null })).toBe('Someone added your preview.');
    expect(settledMessage('discard', null)).toBe('Someone discarded your preview.');
    expect(settledMessage('accept', { id: 'u2', name: '  ' })).toBe('Someone added your preview.');
  });

  it('says so when the preview expired or the run failed, and when the same person settled it elsewhere', () => {
    expect(settledMessage('expired', null)).toBe('Your preview expired. Run it again.');
    expect(settledMessage('failed', null)).toBe('That AI run did not finish. Run it again.');
    expect(settledMessage(null, null)).toBe('Your preview was already settled.');
    expect(settledMessage('accept', { id: 'me', name: 'Ana' }, 'me')).toBe('Your preview was already added.');
    expect(settledMessage('discard', { id: 'me', name: 'Ana' }, 'me')).toBe('Your preview was already discarded.');
  });
});

describe('history', () => {
  it('puts the newest prompt first and drops an earlier copy of it', () => {
    expect(pushHistory(['b', 'a'], 'c')).toEqual(['c', 'b', 'a']);
    expect(pushHistory(['b', 'a'], 'a')).toEqual(['a', 'b']);
    expect(pushHistory(['b', 'a'], '  a  ')).toEqual(['a', 'b']);
  });

  it('ignores an empty prompt and keeps a prompt on one line', () => {
    expect(pushHistory(['a'], '   ')).toEqual(['a']);
    expect(pushHistory([], 'two\nlines  here')).toEqual(['two lines here']);
  });

  it('keeps at most 20', () => {
    let list: string[] = [];
    for (let i = 0; i < 30; i++) list = pushHistory(list, `p${i}`);
    expect(list).toHaveLength(HISTORY_MAX);
    expect(list[0]).toBe('p29');
    expect(list[19]).toBe('p10');
  });

  it('stores newline-separated and reads it back, dropping blanks, repeats and anything past 20', () => {
    expect(serializeHistory(['b', 'a'])).toBe('b\na');
    expect(parseHistory('b\n\na\nb\n')).toEqual(['b', 'a']);
    expect(parseHistory(null)).toEqual([]);
    expect(parseHistory(Array.from({ length: 30 }, (_, i) => `p${i}`).join('\n'))).toHaveLength(20);
  });

  it('walks back with Up from the newest and forward with Down, ending in an empty prompt', () => {
    const list = ['c', 'b', 'a'];
    let step = stepHistory(list, -1, 'up');
    expect(step).toEqual({ index: 0, text: 'c' });
    step = stepHistory(list, step.index, 'up');
    expect(step).toEqual({ index: 1, text: 'b' });
    step = stepHistory(list, 2, 'up');
    expect(step).toEqual({ index: 2, text: 'a' });
    step = stepHistory(list, 2, 'down');
    expect(step).toEqual({ index: 1, text: 'b' });
    expect(stepHistory(list, 0, 'down')).toEqual({ index: -1, text: '' });
    expect(stepHistory(list, -1, 'down')).toEqual({ index: -1, text: '' });
    expect(stepHistory([], -1, 'up')).toEqual({ index: -1, text: '' });
  });

  it('walks only in an empty prompt or while already walking', () => {
    expect(canWalkHistory('', -1)).toBe(true);
    expect(canWalkHistory('typed', -1)).toBe(false);
    expect(canWalkHistory('c', 0)).toBe(true);
  });
});

describe('dock and drag', () => {
  const size = { w: 640, h: 112 };
  const area = { w: 1440, h: 900 };

  it('keeps the bar 8px inside each edge', () => {
    expect(clampPos({ left: -50, bottom: -50 }, size, area)).toEqual({ left: 8, bottom: 8 });
    expect(clampPos({ left: 5000, bottom: 5000 }, size, area)).toEqual({ left: 1440 - 640 - 8, bottom: 900 - 112 - 8 });
    expect(clampPos({ left: 300.4, bottom: 120.6 }, size, area)).toEqual({ left: 300, bottom: 121 });
  });

  it('is clamped again on resize, and lets the left and bottom edges win on a board too small for the bar', () => {
    expect(clampPos({ left: 700, bottom: 700 }, size, { w: 800, h: 400 })).toEqual({ left: 152, bottom: 280 });
    expect(clampPos({ left: 100, bottom: 100 }, size, { w: 500, h: 100 })).toEqual({ left: 8, bottom: 8 });
  });

  it('parses and writes the remembered position', () => {
    expect(parsePos('240,32')).toEqual({ left: 240, bottom: 32 });
    expect(parsePos(' 240 , 32 ')).toEqual({ left: 240, bottom: 32 });
    expect(parsePos('')).toBeNull();
    expect(parsePos(null)).toBeNull();
    expect(parsePos('240')).toBeNull();
    expect(parsePos('a,b')).toBeNull();
    expect(formatPos({ left: 240.4, bottom: 31.6 })).toBe('240,32');
    expect(parsePos(formatPos({ left: 12, bottom: 34 }))).toEqual({ left: 12, bottom: 34 });
  });

  it('moves with the pointer: right and up gain left and bottom', () => {
    expect(dragPos({ left: 100, bottom: 50 }, 30, -20)).toEqual({ left: 130, bottom: 70 });
    expect(dragPos({ left: 100, bottom: 50 }, -30, 20)).toEqual({ left: 70, bottom: 30 });
  });

  it('moves 8px with the arrow keys and 32px with Shift', () => {
    const p = { left: 100, bottom: 100 };
    expect(arrowPos(p, 'ArrowLeft', false)).toEqual({ left: 92, bottom: 100 });
    expect(arrowPos(p, 'ArrowRight', false)).toEqual({ left: 108, bottom: 100 });
    expect(arrowPos(p, 'ArrowUp', false)).toEqual({ left: 100, bottom: 108 });
    expect(arrowPos(p, 'ArrowDown', true)).toEqual({ left: 100, bottom: 68 });
    expect(arrowPos(p, 'Home', false)).toBeNull();
    expect(arrowPos(p, 'a', false)).toBeNull();
  });

  it('docks 16px up, 64px up at 1000px and below, and 8px above the highest bar below it', () => {
    expect(dockBottom({ narrow: false, boardBottom: 900, tops: [] })).toBe(16);
    expect(dockBottom({ narrow: true, boardBottom: 900, tops: [] })).toBe(64);
    expect(dockBottom({ narrow: false, boardBottom: 900, tops: [840] })).toBe(68);
    expect(dockBottom({ narrow: false, boardBottom: 900, tops: [840, 700] })).toBe(208);
    expect(dockBottom({ narrow: true, boardBottom: 900, tops: [880] })).toBe(64);
    expect(dockBottom({ narrow: true, boardBottom: 900, tops: [800] })).toBe(108);
  });

  it('sets --ai-top 8px above the bar\'s top edge', () => {
    expect(aiTop(900, 788)).toBe(120);
    expect(aiTop(900, 860)).toBe(48);
    expect(aiTop(900, 1000)).toBe(0);
  });
});
