import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyPlan, planCreateKanban } from '../server/board-ops.mjs';
import { exportBoardMarkdown } from '../server/board-export.mjs';

const add = (doc: Y.Doc, id: string, fields: Record<string, unknown>) => {
  doc.getMap('objects').set(id, new Y.Map(Object.entries(fields)));
};

describe('exportBoardMarkdown', () => {
  it('renders nested frames, board objects, connectors and kanban cards', () => {
    const doc = new Y.Doc();
    doc.getMap('meta').set('name', 'Quarter plan');
    add(doc, 'frame-1', { type: 'frame', name: 'Roadmap', x: 0, y: 0, w: 500, h: 400, z: 'a0' });
    add(doc, 'frame-2', { type: 'frame', name: 'Next', parent: 'frame-1', x: 10, y: 10, w: 200, h: 200, z: 'a1' });
    add(doc, 'sticky-1', { type: 'sticky', text: '<script>Ship it</script>', parent: 'frame-2', x: 20, y: 20, w: 100, h: 100, z: 'a2' });
    add(doc, 'shape-1', { type: 'shape', kind: 'diamond', text: 'Decision', parent: 'frame-1', x: 250, y: 40, w: 80, h: 60, z: 'a3' });
    add(doc, 'connector-1', {
      type: 'connector',
      from: { kind: 'bound', id: 'sticky-1' },
      to: { kind: 'bound', id: 'shape-1' },
      label: 'connects',
      z: 'a4',
    });
    const kanban = planCreateKanban(doc, { name: 'Delivery', parent: 'frame-1' }, { createdBy: 'test', now: 1 });
    doc.transact(() => applyPlan(doc, kanban), 'test');
    const laneId = kanban.result.lanes[0].id;
    add(doc, 'card-1', { type: 'card', text: 'Build release', parent: laneId, rank: 'a0@lane', x: 0, y: 0, w: 100, h: 80, z: 'a5' });

    const markdown = exportBoardMarkdown(doc);
    expect(markdown).toContain('# Quarter plan');
    expect(markdown).toContain('## Roadmap');
    expect(markdown).toContain('### Next');
    expect(markdown).toContain('- &lt;script&gt;Ship it&lt;/script&gt;');
    expect(markdown).toContain('- Decision');
    expect(markdown).toContain('Ship it&lt;/script&gt; -> Decision (connects)');
    expect(markdown).toContain('### Delivery');
    expect(markdown).toContain('#### To do');
    expect(markdown).toContain('- Build release');
  });

  it('omits unrevealed private notes and cleans invisible and excessive whitespace', () => {
    const doc = new Y.Doc();
    doc.getMap('meta').set('name', 'Notes');
    add(doc, 'secret', { type: 'sticky', text: 'do not export', privateStep: 'step-1', x: 0, y: 0, w: 10, h: 10 });
    add(doc, 'public', { type: 'text', text: '  keep\u200b   this  ', x: 0, y: 20, w: 100, h: 20 });

    const markdown = exportBoardMarkdown(doc);
    expect(markdown).not.toContain('do not export');
    expect(markdown).not.toContain('\u200b');
    expect(markdown).toContain('- keep this');
  });

  it('quotes a Markdown block\'s source so its own headings and lists do not become the summary\'s, cleaned like any board text', () => {
    const doc = new Y.Doc();
    doc.getMap('meta').set('name', 'Notes');
    add(doc, 'frame-1', { type: 'frame', name: 'Meeting', x: 0, y: 0, w: 500, h: 400, z: 'a0' });
    add(doc, 'md-1', { type: 'markdown', text: '# Agenda\n\n- [ ] first\n- [x] second\n\u202egnissim\n\n```\ncode\n```', parent: 'frame-1', x: 20, y: 20, w: 300, h: 200, z: 'a1' });
    add(doc, 'md-empty', { type: 'markdown', text: '  \n ', parent: 'frame-1', x: 20, y: 240, w: 300, h: 100, z: 'a2' });
    const markdown = exportBoardMarkdown(doc);
    expect(markdown).toContain('> # Agenda\n>\n> - [ ] first\n> - [x] second\n> gnissim\n>\n> ```\n> code\n> ```');
    expect(markdown).not.toContain('\u202e');
    expect(markdown.split('\n').filter((l) => l.startsWith('# ') || l.startsWith('## ')).sort()).toEqual(['# Notes', '## Meeting']);
    expect(markdown).not.toContain('md-empty');
  });
});
