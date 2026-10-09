import { describe, expect, it } from 'vitest';
import {
  PREVIEW_PAD, ROW_H, TITLE_BAND, acceptedMessage, avatarLine, badgeRun, clearGhostText, discardedMessage, firstMessage, ghostMarkup, ghostSource, hasTray, intersects,
  isMine, isRunner, labelColors, personColor, placeLabelRows, previewBox, previewLabelText, settledNotice, stacked, targetBounds,
} from '../src/ai-live-logic';
import { layoutProposal, type AiProposal, type Existing, type Layout, type Rect } from '../src/ai-apply';
import type { LiveRun } from '../src/ai-runs';
import { luminance, USER_COLORS } from '../src/palette';

// docs/ai-toolbar.md, "Multiplayer (TAB-141)": what the board draws and says for the AI runs of the people on it.

const run = (id: string, by: Partial<LiveRun['by']> = {}, extra: Partial<LiveRun> = {}): LiveRun => ({
  id, feature: 'generate', status: 'ready', by: { id: 'u-ana', name: 'Ana', color: '#7A5AF8', ...by }, private: false, startedAt: 1, readyAt: 2, target: null, proposal: null, cut: false, ...extra,
});

const board = (objects: Record<string, Existing> = {}) => ({
  content: { x: 0, y: 0, w: 400, h: 300 } as Rect | null,
  get: (id: string) => objects[id],
});
const px1 = (v: number) => v;

const createLayout = (texts: string[], frame?: string): Layout => layoutProposal({ kind: 'create', objects: texts.map((text) => ({ text })), ...(frame ? { frame: { title: frame } } : {}) }, board())!;

describe('whose run is it', () => {
  it('knows the account in accounts mode and the bar run in open mode', () => {
    expect(isMine(run('r1', { id: 'me' }), 'me', null)).toBe(true);
    expect(isMine(run('r1', { id: 'u-ana' }), 'me', null)).toBe(false);
    // open mode: by.id is null, so only the run the bar started is the person's own
    expect(isMine(run('r1', { id: null }), null, 'r1')).toBe(true);
    expect(isMine(run('r2', { id: null }), null, 'r1')).toBe(false);
    expect(isMine(run('r1', { id: null }), null, null)).toBe(false);
  });

  it('tells a request just sent from someone else\'s run by the name and colour it carried', () => {
    const me = { name: 'Ana', color: '#7a5af8' };
    const mine = run('r1', { id: null, name: 'Ana', color: '#7A5AF8' }, { status: 'running' });
    expect(isMine(mine, null, null, me)).toBe(true);
    expect(isMine(mine, null, null, null)).toBe(false);
    // only a run in flight, only in open mode, only as that person
    expect(isMine({ ...mine, status: 'ready' }, null, null, me)).toBe(false);
    expect(isMine(run('r2', { id: 'u-ben', name: 'Ana', color: '#7A5AF8' }, { status: 'running' }), 'u-ana', null, me)).toBe(false);
    expect(isMine(run('r3', { id: null, name: 'Ben', color: '#7A5AF8' }, { status: 'running' }), null, null, me)).toBe(false);
    expect(isMine(run('r4', { id: null, name: 'Ana', color: '#E0559B' }, { status: 'running' }), null, null, me)).toBe(false);
  });

  it('stacks others oldest first and the person own run on top', () => {
    const a = run('a', { id: 'x' }, { startedAt: 1 });
    const b = run('b', { id: 'me' }, { startedAt: 2 });
    const c = run('c', { id: 'y' }, { startedAt: 3 });
    expect(stacked([a, b, c], (r) => r.by.id === 'me').map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });

  it('takes the colour the runner sent, else a cursor colour picked from the id', () => {
    expect(personColor(run('r1', { color: '#E0559B' }))).toBe('#E0559B');
    const picked = personColor(run('r1', { id: 'u-eve', color: null }));
    expect(USER_COLORS).toContain(picked);
    expect(personColor(run('r2', { id: 'u-eve', color: null }))).toBe(picked);
    // open mode: no id, so the run id picks it
    expect(USER_COLORS).toContain(personColor(run('r9', { id: null, color: null })));
  });
});

describe('label colours', () => {
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it('picks white or the ink per the spec table', () => {
    const table: Record<string, string> = {
      '#2F6FED': '#FFFFFF', '#D64545': '#FFFFFF', '#1E9A6A': '#18212B', '#C98A00': '#18212B', '#7A5AF8': '#FFFFFF', '#E0559B': '#18212B', '#0E9AA7': '#18212B', '#E06D2B': '#18212B',
    };
    expect(Object.fromEntries(Object.keys(table).map((color) => [color, labelColors(color).ink]))).toEqual(table);
  });

  it('darkens only the red, which misses 4.5:1 with white', () => {
    const red = labelColors('#D64545');
    expect(red.fill).not.toBe('#D64545');
    expect(contrast(red.fill, red.ink)).toBeGreaterThan(5);
    expect(contrast(red.fill, red.ink)).toBeLessThan(5.2);
    for (const color of USER_COLORS.filter((c) => c !== '#D64545')) {
      const { fill, ink } = labelColors(color);
      expect([color, fill]).toEqual([color, color]);
      expect([color, contrast(fill, ink) >= 4.5]).toEqual([color, true]);
    }
  });

  it('keeps every label legible for any colour', () => {
    for (const color of ['#FF0000', '#00FF00', '#0000FF', '#808080', '#FFFF00', '#123456']) {
      const { fill, ink } = labelColors(color);
      expect([color, contrast(fill, ink) >= 4.5]).toEqual([color, true]);
    }
  });
});

describe('ghost markup', () => {
  const env = (extra: Partial<Parameters<typeof ghostMarkup>[2]> = {}) => ({ px: px1, sticky: () => undefined, ...extra });

  it('draws a create preview: an outline over a wash, a ghost per sticky with a dashed edge', () => {
    clearGhostText();
    const layout = createLayout(['one', 'two', 'three']);
    const svg = ghostMarkup(layout, { color: null }, env());
    expect(svg.startsWith('<g pointer-events="none" aria-hidden="true">')).toBe(true);
    // the person's own: the signal wash and a canvas-ink outline
    expect(svg).toContain('var(--signal');
    expect(svg).toContain('var(--canvas-ink');
    expect(svg).toContain('stroke-opacity="0.55"');
    expect(svg).toContain('stroke-dasharray');
    expect(svg.match(/<g transform="translate\(/g)).toHaveLength(3);
    for (const t of ['one', 'two', 'three']) expect(svg).toContain(t);
    // true colours, no opacity on the stickies
    expect(svg).toContain('fill="#FFE16B"');
    expect(svg).not.toMatch(/<g transform[^>]*opacity/);
  });

  it("draws someone else's preview in their colour", () => {
    const svg = ghostMarkup(createLayout(['one']), { color: '#7A5AF8' }, env());
    expect(svg).toContain('stroke="#7A5AF8"');
    expect(svg).toContain('fill="#7A5AF8" fill-opacity="0.08"');
    expect(svg).toContain('color-mix(in srgb, #7A5AF8 80%');
    expect(svg).not.toContain('var(--signal');
  });

  it('scales strokes and dashes with the zoom, not the stickies', () => {
    const layout = createLayout(['one']);
    const at1 = ghostMarkup(layout, { color: null }, env());
    const at4 = ghostMarkup(layout, { color: null }, env({ px: (v) => v / 4 }));
    expect(at1).toContain('stroke-width="2"');
    expect(at4).toContain('stroke-width="0.5"');
    expect(at4).toContain(`width="${(layout as { stickies: Rect[] }).stickies[0].w}"`);
  });

  it('adds a ghost title when the proposal names a frame', () => {
    const svg = ghostMarkup(createLayout(['one', 'two'], 'Summary'), { color: null }, env());
    expect(svg).toMatch(/<text [^>]*>Summary<\/text>/);
    expect(ghostMarkup(createLayout(['one', 'two']), { color: null }, env())).not.toContain('Summary');
  });

  it('draws a group preview: headers, ghost copies at the new places, arrows from the originals', () => {
    const objects: Record<string, Existing> = {
      a: { type: 'sticky', x: 0, y: 0, w: 192, h: 192 },
      b: { type: 'sticky', x: 216, y: 0, w: 192, h: 192 },
      c: { type: 'sticky', x: 0, y: 216, w: 192, h: 192 },
    };
    const proposal: AiProposal = { kind: 'group', groups: [{ title: 'Pain', ids: ['a', 'c'] }, { title: 'Wins', ids: ['b'] }] };
    const layout = layoutProposal(proposal, board(objects))!;
    const known: Record<string, { text: string; fill: string }> = { a: { text: 'alpha', fill: '#FFB979' }, b: { text: 'beta', fill: '#A3D2FF' }, c: { text: 'gamma', fill: '#BCE88C' } };
    const svg = ghostMarkup(layout, { color: null }, env({ sticky: (id) => known[id] }));
    for (const t of ['Pain', 'Wins', 'alpha', 'beta', 'gamma']) expect(svg).toContain(t);
    expect(svg.match(/<path d="M[^"]*C/g)).toHaveLength(3);
    expect(svg).toContain('fill="#FFB979"');
    // arrows come before the ghost stickies, so the stickies lie over them
    expect(svg.indexOf('C')).toBeLessThan(svg.indexOf('fill="#FFB979"'));
    // a sticky that left the board is not copied
    const missing = ghostMarkup(layout, { color: null }, env({ sticky: (id) => (id === 'a' ? undefined : known[id]) }));
    expect(missing).not.toContain('alpha');
    expect(missing).toContain('beta');
  });

  it('draws text as text, never as markup', () => {
    clearGhostText();
    const evil = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "</text><rect onload='x'/>", '&lt;b&gt; & more'];
    const create = ghostMarkup(createLayout(evil, '"><svg onload=alert(1)>'), { color: '#2F6FED' }, env());
    const objects: Record<string, Existing> = { a: { type: 'sticky', x: 0, y: 0, w: 192, h: 192 } };
    const group = ghostMarkup(layoutProposal({ kind: 'group', groups: [{ title: '<img src=x onerror=alert(1)>', ids: ['a'] }] }, board(objects))!, { color: null }, env({ sticky: () => ({ text: '<script>alert(2)</script>', fill: '"><b>' }) }));
    for (const svg of [create, group]) {
      expect(svg).not.toContain('<script');
      expect(svg).not.toContain('<img');
      expect(svg).not.toContain('<svg');
      expect(svg).not.toContain('<b>');
      expect(svg).not.toMatch(/onerror=[^&]*>/);
      // the only elements are the ones the ghost draws itself
      const tags = new Set([...svg.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
      expect([...tags].filter((t) => !['g', 'rect', 'text', 'tspan', 'path'].includes(t))).toEqual([]);
      // no attribute value was broken out of
      expect(svg).not.toMatch(/"\s*onerror|"\s*onload/);
    }
    // a long line wraps over several tspans, so each piece is looked for on its own
    expect(create).toContain('&lt;script&gt;alert(');
    expect(create).toContain('&lt;/script&gt;');
    expect(create).toContain('&quot;&gt;&lt;img');
    expect(create).toContain('&amp;lt;b&amp;gt;');
    expect(create).toContain('>&quot;&gt;&lt;svg onload=alert(1)&gt;</text>');
    expect(group).toContain('&lt;img src=x');
    expect(group).toContain('onerror=alert(1)&gt;');
    // a fill outside the colour grammar is not drawn at all, escaped or not: the ghost takes the default sticky colour (TAB-203)
    expect(group).not.toContain('&quot;&gt;&lt;b&gt;');
    expect(group).toContain('fill="#FFE16B"');
  });

  it('never copies writing that is hidden from the viewer', () => {
    expect(ghostSource({ text: 'secret', fill: '#FFB979' }, true, '#FFE16B')).toEqual({ text: '', fill: '#FFB979' });
    expect(ghostSource({ text: 'shown' }, false, '#FFE16B')).toEqual({ text: 'shown', fill: '#FFE16B' });
    const objects: Record<string, Existing> = { a: { type: 'sticky', x: 0, y: 0, w: 192, h: 192 } };
    const layout = layoutProposal({ kind: 'group', groups: [{ title: 'T', ids: ['a'] }] }, board(objects))!;
    const svg = ghostMarkup(layout, { color: null }, env({ sticky: () => ghostSource({ text: 'secret plan', fill: '#FFB979' }, true, '#FFE16B') }));
    expect(svg).not.toContain('secret');
    expect(svg).toContain('fill="#FFB979"');
  });

  it('leaves out a group stickies with no text and keeps a fill that is not a colour inert', () => {
    const objects: Record<string, Existing> = { a: { type: 'sticky', x: 0, y: 0, w: 192, h: 192 } };
    const layout = layoutProposal({ kind: 'group', groups: [{ title: 'T', ids: ['a'] }] }, board(objects))!;
    const svg = ghostMarkup(layout, { color: null }, env({ sticky: () => ({ text: '', fill: 'red" onclick="x' }) }));
    expect(svg).not.toContain('onclick="x');
  });
});

describe('where a preview hangs its label', () => {
  it('takes the outline and, with a frame, the title strip', () => {
    const plain = createLayout(['one']);
    expect(previewBox(plain)).toEqual({ x: plain.area.x - PREVIEW_PAD, y: plain.area.y - PREVIEW_PAD, w: plain.area.w + 2 * PREVIEW_PAD, h: plain.area.h + 2 * PREVIEW_PAD });
    const framed = createLayout(['one'], 'Frame');
    expect(previewBox(framed).y).toBe(framed.area.y - PREVIEW_PAD - TITLE_BAND);
    expect(previewBox(framed).h).toBe(framed.area.h + 2 * PREVIEW_PAD + TITLE_BAND);
  });
});

describe('label rows', () => {
  const view = { w: 1000, h: 700 };
  const row = (id: string, x: number, y: number, w = 120, h = 20, aw = 200, ah = 100) => ({ id, anchor: { x, y, w: aw, h: ah }, w, h });

  it('hangs a row above its preview, a hair left of the corner', () => {
    const out = placeLabelRows([row('a', 300, 300)], [], view);
    expect(out.get('a')).toEqual({ x: 298, y: 300 - 20 - 2, below: false });
  });

  it('keeps a row inside the board', () => {
    const out = placeLabelRows([row('a', 950, 300), row('b', -40, 300, 120, 20, 50, 50)], [], view);
    expect(out.get('a')!.x).toBe(1000 - 120 - 8);
    expect(out.get('b')!.x).toBe(8);
    const top = placeLabelRows([row('t', 300, 5)], [], view);
    expect(top.get('t')!.y).toBe(4);
  });

  it('moves under the bottom-left corner when a placed row is in the way', () => {
    const out = placeLabelRows([row('a', 300, 300), row('b', 320, 300)], [], view);
    expect(out.get('a')!.below).toBe(false);
    expect(out.get('b')).toEqual({ x: 318, y: 300 + 100 + 2, below: true });
  });

  it('steps down 24px at a time while the spot under is taken too', () => {
    const rows = [row('a', 300, 300), row('b', 300, 300), row('c', 300, 300)];
    const out = placeLabelRows(rows, [], view);
    expect(out.get('a')!.y).toBe(278);
    expect(out.get('b')).toEqual({ x: 298, y: 402, below: true });
    expect(out.get('c')!.below).toBe(true);
    expect(out.get('c')!.y).toBe(426);
  });

  it('avoids the quick bar and the AI bar as well', () => {
    const quickBar = { x: 280, y: 270, w: 200, h: 40 };
    const out = placeLabelRows([row('a', 300, 300)], [quickBar], view);
    expect(out.get('a')!.below).toBe(true);
    const bothBars = placeLabelRows([row('a', 300, 300)], [quickBar, { x: 280, y: 400, w: 300, h: 60 }], view);
    expect(bothBars.get('a')!.below).toBe(true);
    expect(bothBars.get('a')!.y).toBeGreaterThanOrEqual(460 + 2 - ROW_H);
    for (const o of [quickBar, { x: 280, y: 400, w: 300, h: 60 }]) {
      const r = { x: bothBars.get('a')!.x, y: bothBars.get('a')!.y, w: 120, h: 20 };
      expect(intersects(r, o)).toBe(false);
    }
  });

  it('places rows in the order it is given, so a later row yields to an earlier one', () => {
    const forward = placeLabelRows([row('a', 300, 300), row('b', 300, 300)], [], view);
    const backward = placeLabelRows([row('b', 300, 300), row('a', 300, 300)], [], view);
    expect(forward.get('a')!.below).toBe(false);
    expect(backward.get('a')!.below).toBe(true);
  });

  it('gives up stepping after a while rather than looping', () => {
    const wall = { x: 0, y: 0, w: 1000, h: 700 };
    const out = placeLabelRows([row('a', 300, 300)], [wall], view);
    expect(out.get('a')).toBeDefined();
  });
});

describe('target outline', () => {
  const rects: Record<string, Rect> = { a: { x: 0, y: 0, w: 100, h: 50 }, b: { x: 200, y: 100, w: 100, h: 100 }, f: { x: -50, y: -50, w: 500, h: 400 } };
  const bounds = (id: string) => rects[id] ?? null;

  it('is the bounds of the selection, ignoring what is gone', () => {
    expect(targetBounds({ ids: ['a', 'b'] }, bounds)).toEqual({ x: 0, y: 0, w: 300, h: 200 });
    expect(targetBounds({ ids: ['a', 'gone'] }, bounds)).toEqual(rects.a);
  });

  it('is the frame when the run was on a frame', () => {
    expect(targetBounds({ frameId: 'f' }, bounds)).toEqual(rects.f);
  });

  it('is nothing for a prompt-only run, a missing frame or a selection that is gone', () => {
    expect(targetBounds(null, bounds)).toBeNull();
    expect(targetBounds({ frameId: 'gone' }, bounds)).toBeNull();
    expect(targetBounds({ ids: ['gone', 'also'] }, bounds)).toBeNull();
  });
});

describe('words', () => {
  const proposal: AiProposal = { kind: 'create', objects: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }] };
  const group: AiProposal = { kind: 'group', groups: [{ title: 'G', ids: ['a', 'b'] }, { title: 'H', ids: ['c'] }] };

  it('labels a preview with the runner, or "Your" for the person own', () => {
    expect(previewLabelText(run('r1'), true)).toBe('Your AI preview');
    expect(previewLabelText(run('r1'), false)).toBe("Ana's AI preview");
    // open mode names nobody
    expect(previewLabelText(run('r1', { id: null, name: null }), false)).toBe('AI preview');
  });

  it("says what was added from someone else's preview", () => {
    expect(acceptedMessage(proposal, 'Ana')).toBe("Added Ana's 4 stickies.");
    expect(acceptedMessage({ kind: 'create', objects: [{ text: 'a' }] }, 'Ana')).toBe("Added Ana's 1 sticky.");
    expect(acceptedMessage(proposal, null)).toBe('Added 4 stickies.');
    expect(acceptedMessage(group, 'Ana')).toBe("Moved Ana's 3 stickies into 2 groups.");
    expect(acceptedMessage(group, null)).toBe('Moved 3 stickies into 2 groups.');
  });

  it('says what was discarded', () => {
    expect(discardedMessage('Ana')).toBe("Discarded Ana's preview.");
    expect(discardedMessage(null)).toBe('Discarded the preview.');
  });

  it('tells who got there first', () => {
    const ana = { id: 'u-ana', name: 'Ana' };
    const ben = { id: 'u-ben', name: 'Ben' };
    expect(firstMessage('accept', ana, ana)).toBe('Ana added their preview first.');
    expect(firstMessage('discard', ana, ana)).toBe('Ana discarded their preview first. Nothing was added.');
    expect(firstMessage('accept', ben, ana)).toBe("Ben added Ana's preview first.");
    expect(firstMessage('discard', ben, ana)).toBe("Ben discarded Ana's preview first. Nothing was added.");
  });

  it('copes with names that are missing (open mode)', () => {
    const nobody = { id: null, name: null };
    expect(firstMessage('accept', nobody, nobody)).toBe('Someone added the preview first.');
    expect(firstMessage('discard', { id: null, name: 'Ben' }, nobody)).toBe('Ben discarded the preview first. Nothing was added.');
    expect(firstMessage('accept', null, { id: 'u-ana', name: 'Ana' })).toBe("Someone added Ana's preview first.");
    // the same name in open mode is the same person
    expect(firstMessage('accept', { id: null, name: 'Ana' }, { id: null, name: 'Ana' })).toBe('Ana added their preview first.');
  });

  it('says so when the preview ran out or the run failed, or the person settled it elsewhere', () => {
    const ana = { id: 'u-ana', name: 'Ana' };
    expect(firstMessage('expired', null, ana)).toBe("Ana's preview expired.");
    expect(firstMessage('expired', null, null)).toBe('The preview expired.');
    expect(firstMessage('failed', null, ana)).toBe('That AI run did not finish.');
    expect(firstMessage(null, null, ana)).toBe("Ana's preview was already settled.");
    expect(firstMessage('accept', { id: 'me', name: 'Me' }, ana, 'me')).toBe("Ana's preview was already added.");
    expect(firstMessage('discard', { id: 'me', name: 'Me' }, ana, 'me')).toBe("Ana's preview was already discarded.");
  });

  it("tells the runner when someone else settled their preview", () => {
    expect(settledNotice({ status: 'accepted', resolvedBy: { id: 'u-ben', name: 'Ben' } }, 'me')).toBe('Ben added your preview.');
    expect(settledNotice({ status: 'discarded', resolvedBy: { id: 'u-ben', name: 'Ben' } }, 'me')).toBe('Ben discarded your preview.');
    expect(settledNotice({ status: 'expired', resolvedBy: null }, 'me')).toBe('Your preview expired. Run it again.');
    expect(settledNotice({ status: 'accepted', resolvedBy: { id: null, name: null } }, null)).toBe('Someone added your preview.');
    expect(settledNotice({ status: 'accepted', resolvedBy: { id: 'me', name: 'Ana' } }, 'me')).toBe('Your preview was already added.');
  });
});

describe('the presence tray', () => {
  const ana = { id: 'device-1', name: 'Ana', color: '#7A5AF8' };

  it('matches a runner by account, or by the name and colour they sent', () => {
    expect(isRunner({ ...ana, id: 'u-ana' }, { id: 'u-ana', name: null, color: null })).toBe(true);
    // the room knows a device, the relay an account: the name and colour decide
    expect(isRunner(ana, { id: 'u-ana', name: 'Ana', color: '#7a5af8' })).toBe(true);
    expect(isRunner(ana, { id: 'u-ana', name: 'Ben', color: '#7A5AF8' })).toBe(false);
    expect(isRunner(ana, { id: 'u-ana', name: 'Ana', color: '#E0559B' })).toBe(false);
    expect(isRunner(ana, { id: null, name: 'Ana', color: '#7A5AF8' })).toBe(true);
    // nothing to go on
    expect(isRunner(ana, { id: null, name: null, color: '#7A5AF8' })).toBe(false);
    expect(isRunner(ana, { id: null, name: null, color: null })).toBe(false);
  });

  it('badges the runner while they have a run or a preview, the run first', () => {
    const running = run('r1', {}, { status: 'running', feature: 'summarise', startedAt: 5, readyAt: null });
    const preview = run('r2', {}, { startedAt: 1 });
    expect(badgeRun(ana, [])).toBeNull();
    expect(badgeRun(ana, [preview])?.id).toBe('r2');
    expect(badgeRun(ana, [preview, running])?.id).toBe('r1');
    expect(badgeRun(ana, [run('r3', { name: 'Ben', color: '#E0559B' })])).toBeNull();
  });

  it('words the tooltip', () => {
    expect(avatarLine(run('r1', {}, { status: 'running', feature: 'summarise' }))).toBe('Ana is asking AI: Summarise…');
    expect(avatarLine(run('r1', {}, { status: 'running', feature: 'cluster', by: { id: null, name: null, color: null } }))).toBe('Someone is asking AI: Cluster…');
    expect(avatarLine(run('r1'))).toBe('Ana has an AI preview on this board');
  });

  it('keeps the Discard and Accept tray for editors, and off the run the bar acts on', () => {
    expect(hasTray(run('r1'), { readOnly: false, barRunId: null })).toBe(true);
    expect(hasTray(run('r1'), { readOnly: true, barRunId: null })).toBe(false);
    expect(hasTray(run('r1'), { readOnly: false, barRunId: 'r1' })).toBe(false);
    expect(hasTray(run('r1'), { readOnly: false, barRunId: 'r2' })).toBe(true);
  });
});
