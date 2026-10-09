import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import { Flow, imageLine } from '../src/flow';
import { mdText } from '../src/md-text';
import type { BaseObj, Poll } from '../src/types';

// Every user string in the Markdown summary and in "Copy results" goes through mdText: the board's name, a frame's name, a
// sticky's text, a picture's description and type, a poll's question and options, and the names of people who voted. Each
// line type gets hostile text here; none of it may stay live Markdown (links, images, HTML, code, emphasis, tables,
// headings, lists, quotes, character references) or start a line of its own.

const HOSTILE = '![x](https://evil.example/p.png) [l](javascript:alert(1)) <img src=x onerror=1> `c` *e* _u_ | t | ~~s~~ &amp;';
const LINE_BREAKS = ['\n', '\r', '\u0085', ' ', ' '];

/** What is left after the backslash escapes go: nothing a Markdown reader would act on. */
function bare(line: string) {
  return line.replace(/\\./g, '');
}
function expectLiteral(line: string) {
  const text = bare(line);
  for (const ch of ['<', '[', ']', '`', '|', '*', '_', '~', '&']) expect(text, `${ch} in ${line}`).not.toContain(ch);
}

function app(userName = 'name-me') {
  const store = new Store(new Y.Doc());
  const a = {
    store, user: { id: 'me', name: userName, color: '#123456' }, conn: { comments: { list: () => [] } },
    r: { invalidateAll() {}, setOverlay() {}, flyTo() {}, flyToCenter() {}, viewport: () => ({ x: 0, y: 0, w: 100, h: 100 }), contentBounds: () => null },
    zoom: 1, emit() {}, participants: () => [], stickyColor: '#FFD23F', insertObjects() {},
  };
  const flow = new Flow(a as never);
  Object.assign(a, { flow });
  return { store, flow };
}

const box = (id: string, extra: Partial<BaseObj>): BaseObj => ({ id, type: 'sticky', x: 0, y: 0, w: 100, h: 100, rotation: 0, z: `a${id}`, ...extra });

describe('mdText', () => {
  it('folds every kind of line break and escapes what starts a block', () => {
    const t = mdText(`a${LINE_BREAKS.join('')}c`);
    for (const ch of LINE_BREAKS) expect(t).not.toContain(ch);
    expect(t).toBe('a c');
    expect(mdText('# h')).toBe('\\# h');
    expect(mdText('> q')).toBe('\\> q');
    expect(mdText('- i')).toBe('\\- i');
    expect(mdText('+ i')).toBe('\\+ i');
    expect(mdText('1. i')).toBe('1\\. i');
    expect(mdText('2) i')).toBe('2\\) i');
    expect(mdText(undefined)).toBe('');
  });
});

describe('the session summary keeps user text literal', () => {
  it('the board name, a heading', () => {
    const { store, flow } = app();
    store.setMeta({ name: `# ${HOSTILE}\n## two` });
    const md = flow.summaryMarkdown();
    const [first] = md.split('\n');
    expect(first.startsWith('# \\#')).toBe(true);
    expectLiteral(first.slice(2));
    expect(md.split('\n').filter((l) => l.startsWith('#'))).toHaveLength(1);
  });

  it('a frame name, a sub-heading', () => {
    const { store, flow } = app();
    store.transact(() => {
      store.create(box('f', { type: 'frame', x: -50, y: -50, w: 400, h: 400, name: `${HOSTILE}\n# x` }));
      store.create(box('s', { parent: 'f', text: 'note' }));
    });
    const heading = flow.summaryMarkdown().split('\n').filter((l) => l.startsWith('##'));
    expect(heading).toHaveLength(1);
    expectLiteral(heading[0].slice(3));
  });

  it('a sticky, a bullet: text with a heading, a list, a quote and a line break inside stays one bullet', () => {
    const { store, flow } = app();
    store.transact(() => {
      store.create(box('f', { type: 'frame', x: -50, y: -50, w: 400, h: 400, name: 'F' }));
      store.create(box('s', { parent: 'f', text: `${HOSTILE}\n# h - l\u0085> q\r1. n` }));
      store.create(box('t', { parent: 'f', y: 150, text: '# starts as a heading' }));
    });
    const lines = flow.summaryMarkdown().split('\n');
    const bullets = lines.filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(2);
    for (const b of bullets) expectLiteral(b.slice(2));
    expect(bullets.some((b) => b === '- \\# starts as a heading')).toBe(true);
    expect(lines.filter((l) => l.startsWith('#')).length).toBe(2);
    for (const ch of LINE_BREAKS.slice(1)) expect(lines.join('')).not.toContain(ch);
  });

  it('a picture: its description and its type', () => {
    expect(imageLine(box('i', { type: 'image', alt: HOSTILE } as Partial<BaseObj>))).toMatch(/^Image: /);
    expectLiteral(imageLine(box('i', { type: 'image', alt: HOSTILE } as Partial<BaseObj>)).slice(7));
    const noAlt = imageLine(box('i', { type: 'image', mime: `image/png) ${HOSTILE}` } as Partial<BaseObj>));
    expect(noAlt.startsWith('Image (image/png')).toBe(true);
    expectLiteral(noAlt.slice(7));
  });
});

describe('poll results keep user text literal', () => {
  function revealed(userName: string, anonymous: boolean) {
    const { store, flow } = app(userName);
    flow.quickPoll({ question: `# ${HOSTILE}`, options: [`1. ${HOSTILE}`, '> two'], multiple: false, anonymous });
    const poll = flow.polls.get(flow.activeStep()!.pollId!) as Poll;
    flow.polls.choose(poll.id, poll.options[0].id);
    flow.polls.reveal(poll.id);
    return { store, flow, poll };
  }

  it('the question heading, the option lines and the names of voters in the summary', () => {
    const { flow } = revealed(`Eve ${HOSTILE}`, false);
    const md = flow.summaryMarkdown();
    const q = md.split('\n').find((l) => l.startsWith('### '))!;
    expect(q.startsWith('### \\#')).toBe(true);
    expectLiteral(q.slice(4));
    const option = md.split('\n').find((l) => l.startsWith('1\\. ') || l.startsWith('1. '))!;
    expect(option.startsWith('1. 1\\. ')).toBe(true);
    // the board's heading, Polls and the question: the question's own # is escaped
    expect(md.split('\n').filter((l) => l.startsWith('#'))).toHaveLength(3);
    const names = option.slice(option.lastIndexOf(' - ') + 3);
    expectLiteral(names.replace('Eve ', ''));
  });

  it('Copy results: the bold question and the same lines', () => {
    const { flow, poll } = revealed(`Eve ${HOSTILE}`, false);
    const text = flow.polls.copyText(poll.id);
    const [head, ...rest] = text.split('\n');
    expect(head.startsWith('**\\#')).toBe(true);
    expectLiteral(head.slice(2, -2));
    for (const l of rest) expectLiteral(l.replace(/^\d+\. /, '').replace(/ \((\d+)(, \d+%)?\)/g, '').replace(/ responses?$/, '').replace(/^Eve /, ''));
  });
});
