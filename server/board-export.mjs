// Small Markdown export for MCP. Every board-authored string is cleaned before formatting.
import { boardTitle, cleanForModel, isLine, readAll } from './board-ops.mjs';
import { CODE_LANG_IDS, DEFAULT_CODE_LANG, MAX_CODE_CHARS } from '../shared/code-langs.mjs';
import { parseTableKey, toMarkdownTable } from '../shared/tables.mjs';

function inline(value, max = 20_000) {
  return cleanForModel(value, max).text
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/([\\\x60*_{}[\]()#+.!|])/gu, '\\$1');
}

const objectLabel = (object) => inline(object.name || object.text || object.label || object.kind || object.id || object.type || 'Object', 200);

/** Render a board as compact Markdown, using readAll's private-note withholding. */
export function exportBoardMarkdown(doc, titleOverride = undefined) {
  const { boxes, connectors } = readAll(doc);
  const objects = [...boxes, ...connectors];
  const byId = new Map(objects.map((object) => [object.id, object]));
  const frames = boxes.filter((object) => object.type === 'frame');
  const containers = boxes.filter((object) => object.type === 'container');
  const lanes = boxes.filter((object) => object.type === 'lane');
  const cards = boxes.filter((object) => object.type === 'card');

  const ancestorFrame = (object, includeSelf = false) => {
    let parentId = includeSelf ? object.id : object.parent;
    const seen = new Set();
    while (typeof parentId === 'string' && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) return null;
      if (parent.type === 'frame') return parent.id;
      parentId = parent.parent;
    }
    return null;
  };
  const nearestFrame = (object) => ancestorFrame(object);
  const sortObjects = (items) => items.slice().sort((a, b) => (a.z || '').localeCompare(b.z || '') || a.id.localeCompare(b.id));
  const title = typeof titleOverride === 'string' ? titleOverride : boardTitle(doc);
  const lines = ['# ' + (inline(title, 200) || 'Untitled board')];
  const rendered = new Set();

  const itemLine = (object) => {
    if (isLine(object)) {
      // a line is shown as a line with its two points, not as a connector between ends
      const point = (end) => '(' + String(Math.round(end.x * 100) / 100) + ', ' + String(Math.round(end.y * 100) / 100) + ')';
      return '- Line ' + point(object.from) + ' to ' + point(object.to);
    }
    if (object.type === 'connector') {
      const endpoint = (end) => {
        if (end?.kind === 'bound') return objectLabel(byId.get(end.id) || { id: end.id, type: 'Object' });
        if (end?.kind === 'free') return inline(String(end.x) + ', ' + String(end.y), 80);
        return 'Unknown';
      };
      const label = typeof object.label === 'string' && object.label ? ' (' + inline(object.label, 200) + ')' : '';
      return '- ' + endpoint(object.from) + ' -> ' + endpoint(object.to) + label;
    }
    if (object.type === 'card') return '- ' + objectLabel(object);
    if (object.type === 'markdown') {
      // the block's own Markdown, quoted so its headings and lists do not become the summary's: one line each, cleaned like every board-authored string
      const lines = cleanForModel(object.text, 4_000).text.split(/\r?\n/u).map((line) => line.replace(/\s+$/u, ''));
      return lines.length && lines.some(Boolean) ? lines.map((line) => (line ? '> ' + line : '>')).join('\n') : null;
    }
    if (object.type === 'code') {
      // the code in a fenced block named by its language id; the fence is longer than any run of backticks in the code, so the code cannot close it
      const code = cleanForModel(object.text, MAX_CODE_CHARS).text.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '');
      if (!code.trim()) return null;
      const longest = Math.max(0, ...(code.match(/`+/gu) ?? []).map((run) => run.length));
      const fence = '`'.repeat(Math.max(3, longest + 1));
      const lang = typeof object.lang === 'string' && CODE_LANG_IDS.includes(object.lang) ? object.lang : DEFAULT_CODE_LANG;
      const title = typeof object.title === 'string' && object.title.trim() ? inline(object.title, 100) + '\n\n' : '';
      return title + fence + lang + '\n' + code + '\n' + fence;
    }
    if (object.type === 'table') {
      // a table as a Markdown table, quoted like a Markdown block; every cell is cleaned like any board-authored string
      const clean = Object.fromEntries(Object.entries(object).map(([k, v]) => [k, parseTableKey(k)?.kind === 'c' && typeof v === 'string' ? cleanForModel(v, 1_000).text : v]));
      const table = toMarkdownTable(clean);
      return table ? table.split('\n').map((line) => '> ' + line).join('\n') : null;
    }
    if (object.type === 'sticky' || object.type === 'text' || object.type === 'shape') {
      const text = typeof object.text === 'string' && object.text ? inline(object.text) : '';
      const description = text || (object.type === 'shape' ? 'Shape (' + inline(object.kind || 'unknown', 80) + ')' : object.type);
      return '- ' + description;
    }
    return null;
  };

  const renderKanban = (frameId, level) => {
    for (const container of sortObjects(containers.filter((item) => nearestFrame(item) === frameId))) {
      const depth = Math.min(6, level + 1);
      lines.push('', '#'.repeat(depth) + ' ' + (objectLabel(container) || 'Kanban'));
      rendered.add(container.id);
      const containerLanes = sortObjects(lanes.filter((lane) => lane.parent === container.id));
      for (const lane of containerLanes) {
        lines.push('', '#'.repeat(Math.min(6, depth + 1)) + ' ' + (objectLabel(lane) || 'Lane'));
        rendered.add(lane.id);
        for (const card of sortObjects(cards.filter((item) => item.parent === lane.id))) {
          const line = itemLine(card);
          if (line) lines.push(line);
          rendered.add(card.id);
        }
      }
    }
  };

  const renderFrame = (frame, level) => {
    const depth = Math.min(6, level + 2);
    lines.push('', '#'.repeat(depth) + ' ' + (objectLabel(frame) || 'Frame'));
    rendered.add(frame.id);
    for (const object of sortObjects(objects.filter((item) => item.type !== 'frame'
      && item.type !== 'container' && item.type !== 'lane' && item.type !== 'card'
      && nearestFrame(item) === frame.id))) {
      const line = itemLine(object);
      if (line) lines.push(line);
      rendered.add(object.id);
    }
    renderKanban(frame.id, depth);
    for (const child of sortObjects(frames.filter((item) => nearestFrame(item) === frame.id))) renderFrame(child, level + 1);
  };

  for (const object of sortObjects(objects.filter((item) => nearestFrame(item) === null
    && item.type !== 'frame' && item.type !== 'container' && item.type !== 'lane' && item.type !== 'card'))) {
    const line = itemLine(object);
    if (line) lines.push(line);
    rendered.add(object.id);
  }
  renderKanban(null, 2);
  for (const frame of sortObjects(frames.filter((item) => nearestFrame(item) === null))) renderFrame(frame, 0);

  // Cards without a readable lane still have meaning as board objects; keep them visible in an unassigned section.
  const unassignedCards = sortObjects(cards.filter((card) => !rendered.has(card.id)));
  if (unassignedCards.length) {
    lines.push('', '## Unassigned cards');
    for (const card of unassignedCards) lines.push(itemLine(card));
  }
  return lines.join('\n').trimEnd() + '\n';
}
