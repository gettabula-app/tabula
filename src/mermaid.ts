// Mermaid ⇄ board. Import supports the common subset of flowchart, classDiagram,
// stateDiagram-v2 and sequenceDiagram; export writes flowchart or classDiagram.

import type { BaseObj, ConnectorObj, End, Head, Member, Obj, ShapeKind, UmlRelation } from './types';
import { isBox, isConnector } from './types';
import { RELATIONS, classHeight, memberToString, parseMember } from './uml';
import { fontCss, measure } from './text';

export interface Parsed {
  nodes: { id: string; label: string; kind: 'shape' | 'class' | 'actor' | 'initial' | 'final' | 'state' | 'lifeline'; shape?: ShapeKind; members?: Member[]; stereotype?: string }[];
  edges: { from: string; to: string; label?: string; relation?: UmlRelation; dashed?: boolean; startHead?: Head; endHead?: Head; order?: number }[];
  direction: 'TB' | 'LR';
  type: 'flowchart' | 'class' | 'state' | 'sequence';
}

const NODE_RE = /^([A-Za-z0-9_À-￿-]+)\s*(\(\(.*?\)\)|\(\[.*?\]\)|\[\(.*?\)\]|\[\[.*?\]\]|\[\/.*?\/\]|\{\{.*?\}\}|\[.*?\]|\(.*?\)|\{.*?\}|>.*?\])?/u;

function nodeShape(tok: string | undefined): { label?: string; shape: ShapeKind } {
  if (!tok) return { shape: 'rounded' };
  const strip = (s: string, a: number, b: number) => s.slice(a, s.length - b).replace(/^"|"$/g, '');
  if (tok.startsWith('((')) return { label: strip(tok, 2, 2), shape: 'ellipse' };
  if (tok.startsWith('([')) return { label: strip(tok, 2, 2), shape: 'terminator' };
  if (tok.startsWith('[(')) return { label: strip(tok, 2, 2), shape: 'cylinder' };
  if (tok.startsWith('[[')) return { label: strip(tok, 2, 2), shape: 'predefined' };
  if (tok.startsWith('[/')) return { label: strip(tok, 2, 2), shape: 'parallelogram' };
  if (tok.startsWith('{{')) return { label: strip(tok, 2, 2), shape: 'hexagon' };
  if (tok.startsWith('[')) return { label: strip(tok, 1, 1), shape: 'rect' };
  if (tok.startsWith('(')) return { label: strip(tok, 1, 1), shape: 'rounded' };
  if (tok.startsWith('{')) return { label: strip(tok, 1, 1), shape: 'diamond' };
  if (tok.startsWith('>')) return { label: strip(tok, 1, 1), shape: 'manual-input' };
  return { shape: 'rounded' };
}

export function parseMermaid(src: string): Parsed {
  const lines = src.split(/\r?\n/).map((l) => l.replace(/%%.*$/, '').trim()).filter(Boolean);
  if (!lines.length) throw new Error('Paste a Mermaid diagram to import.');
  const head = lines[0];
  if (head.startsWith('classDiagram')) return parseClassDiagram(lines.slice(1));
  if (head.startsWith('stateDiagram')) return parseState(lines.slice(1));
  if (head.startsWith('sequenceDiagram')) return parseSequence(lines.slice(1));
  const m = head.match(/^(flowchart|graph)\s*(TD|TB|LR|RL|BT)?/);
  if (!m) throw new Error('Supported diagrams: flowchart, classDiagram, stateDiagram-v2 and sequenceDiagram.');
  return parseFlowchart(lines.slice(1), m[2] === 'LR' || m[2] === 'RL' ? 'LR' : 'TB');
}

function parseFlowchart(lines: string[], direction: 'TB' | 'LR'): Parsed {
  const nodes = new Map<string, Parsed['nodes'][number]>();
  const edges: Parsed['edges'] = [];
  const ensure = (tok: string) => {
    const m = tok.trim().match(NODE_RE);
    if (!m) return null;
    const id = m[1];
    const s = nodeShape(m[2]);
    const ex = nodes.get(id);
    if (!ex) nodes.set(id, { id, label: s.label ?? id, kind: 'shape', shape: s.shape });
    else if (s.label) Object.assign(ex, { label: s.label, shape: s.shape });
    return id;
  };
  const EDGE = /\s*(<?(?:-->|---|-\.->|-\.-|==>|===|--[^->|]+-->|--o|--x)>?)\s*(?:\|([^|]*)\|)?\s*/;
  for (const line of lines) {
    if (/^(subgraph|end$|style|classDef|class |click|linkStyle|direction)/.test(line)) continue;
    const parts = line.split(EDGE);
    if (parts.length === 1) {
      ensure(line);
      continue;
    }
    // parts: node, arrow, label, node, arrow, label, node ...
    let prev = ensure(parts[0]);
    for (let i = 1; i + 2 < parts.length + 1; i += 3) {
      const arrow = parts[i] || '-->';
      let label = parts[i + 1];
      const next = ensure(parts[i + 2] ?? '');
      const inline = arrow.match(/^--\s*(.+?)\s*-->$/);
      if (inline) label = inline[1];
      if (prev && next) {
        edges.push({
          from: prev, to: next, label: label?.trim() || undefined,
          dashed: arrow.includes('.'),
          endHead: arrow.endsWith('>') ? 'arrow' : 'none',
          startHead: arrow.startsWith('<') ? 'arrow' : 'none',
        });
      }
      prev = next;
    }
  }
  return { nodes: [...nodes.values()], edges, direction, type: 'flowchart' };
}

const CLASS_REL: [RegExp, UmlRelation, boolean][] = [
  // [pattern, relation, reversed (arrowhead sits at the left-hand class)]
  [/<\|--/, 'generalization', true],
  [/--\|>/, 'generalization', false],
  [/<\|\.\./, 'realization', true],
  [/\.\.\|>/, 'realization', false],
  [/\*--/, 'composition', false],
  [/--\*/, 'composition', true],
  [/o--/, 'aggregation', false],
  [/--o/, 'aggregation', true],
  [/<--/, 'directed', true],
  [/-->/, 'directed', false],
  [/<\.\./, 'dependency', true],
  [/\.\.>/, 'dependency', false],
  [/--/, 'association', false],
  [/\.\./, 'dependency', false],
];

function parseClassDiagram(lines: string[]): Parsed {
  const nodes = new Map<string, Parsed['nodes'][number]>();
  const edges: Parsed['edges'] = [];
  const ensure = (id: string) => {
    id = id.replace(/~.*?~/g, '').trim();
    if (!nodes.has(id)) nodes.set(id, { id, label: id, kind: 'class', members: [] });
    return nodes.get(id)!;
  };
  let open: Parsed['nodes'][number] | null = null;
  for (const line of lines) {
    if (open) {
      if (line === '}') { open = null; continue; }
      const st = line.match(/^<<(.+)>>$/);
      if (st) open.stereotype = st[1].toLowerCase();
      else open.members!.push(parseMember(line.replace(/\s*\$$/, '').replace(/\*$/, '')));
      continue;
    }
    const cls = line.match(/^class\s+([^\s{]+)\s*(\{)?\s*$/);
    if (cls) {
      const n = ensure(cls[1]);
      if (cls[2]) open = n;
      continue;
    }
    const ann = line.match(/^<<(.+)>>\s+(\S+)/);
    if (ann) { ensure(ann[2]).stereotype = ann[1].toLowerCase(); continue; }
    const mem = line.match(/^(\S+)\s*:\s*(.+)$/);
    let matched = false;
    for (const [re, rel, rev] of CLASS_REL) {
      const m = line.match(new RegExp(`^(\\S+)\\s*(?:"[^"]*"\\s*)?${re.source}\\s*(?:"[^"]*"\\s*)?(\\S+)\\s*(?::\\s*(.+))?$`));
      if (m) {
        const a = ensure(m[1]).id, b = ensure(m[2]).id;
        // Edge runs from the class without the head to the class with it, so the
        // head lands at the right end. Composition/aggregation diamonds go at the start.
        if (rel === 'composition' || rel === 'aggregation') edges.push({ from: rev ? b : a, to: rev ? a : b, relation: rel, label: m[3] });
        else edges.push({ from: rev ? b : a, to: rev ? a : b, relation: rel, label: m[3] });
        matched = true;
        break;
      }
    }
    if (!matched && mem) ensure(mem[1]).members!.push(parseMember(mem[2]));
  }
  return { nodes: [...nodes.values()], edges, direction: 'TB', type: 'class' };
}

function parseState(lines: string[]): Parsed {
  const nodes = new Map<string, Parsed['nodes'][number]>();
  const edges: Parsed['edges'] = [];
  let starts = 0, ends = 0;
  const ensure = (id: string, isTarget: boolean) => {
    if (id === '[*]') {
      const nid = isTarget ? `__end${ends++}` : `__start${starts++}`;
      nodes.set(nid, { id: nid, label: '', kind: isTarget ? 'final' : 'initial' });
      return nid;
    }
    if (!nodes.has(id)) nodes.set(id, { id, label: id, kind: 'state' });
    return id;
  };
  for (const line of lines) {
    const t = line.match(/^(\S+)\s*-->\s*(\S+)\s*(?::\s*(.+))?$/);
    if (t) {
      const a = ensure(t[1], false), b = ensure(t[2], true);
      edges.push({ from: a, to: b, relation: 'transition', label: t[3] });
      continue;
    }
    const named = line.match(/^state\s+"(.+)"\s+as\s+(\S+)/);
    if (named) {
      nodes.get(ensure(named[2], false))!.label = named[1];
      continue;
    }
    const desc = line.match(/^(\S+)\s*:\s*(.+)$/);
    if (desc) nodes.get(ensure(desc[1], false))!.label = desc[2];
  }
  return { nodes: [...nodes.values()], edges, direction: 'TB', type: 'state' };
}

function parseSequence(lines: string[]): Parsed {
  const nodes = new Map<string, Parsed['nodes'][number]>();
  const edges: Parsed['edges'] = [];
  const ensure = (id: string, label?: string, actor = false) => {
    if (!nodes.has(id)) nodes.set(id, { id, label: label ?? id, kind: actor ? 'actor' : 'lifeline' });
    return id;
  };
  let order = 0;
  for (const line of lines) {
    const p = line.match(/^(participant|actor)\s+(\S+)(?:\s+as\s+(.+))?$/);
    if (p) { ensure(p[2], p[3], p[1] === 'actor'); continue; }
    const m = line.match(/^(\S+?)\s*(-->>|->>|-->|->|-\)|--\)|-x|--x)\s*(\S+?)\s*:\s*(.*)$/);
    if (m) {
      const a = ensure(m[1]), b = ensure(m[3]);
      const rel: UmlRelation = m[2].startsWith('--') ? 'reply' : m[2].includes(')') ? 'async' : 'message';
      edges.push({ from: a, to: b, label: m[4], relation: rel, order: order++ });
    }
  }
  return { nodes: [...nodes.values()], edges, direction: 'LR', type: 'sequence' };
}

// ---------------------------------------------------------------- layout

export interface Factory {
  box: (type: BaseObj['type'], x: number, y: number, w: number, h: number, extra: Partial<BaseObj>) => BaseObj;
  connector: (from: End, to: End, extra: Partial<ConnectorObj>) => ConnectorObj;
}

/** Layered layout: rank by longest path from sources, order by first appearance. */
export function layout(p: Parsed, origin: { x: number; y: number }, f: Factory): Obj[] {
  const out: Obj[] = [];
  const ids = new Map<string, BaseObj>();

  if (p.type === 'sequence') {
    const msgs = p.edges.length;
    const height = 140 + msgs * 56 + 60;
    p.nodes.forEach((n, i) => {
      const x = origin.x + i * 240;
      if (n.kind === 'actor') {
        const a = f.box('uml-actor', x + 40, origin.y - 120, 60, 110, { text: n.label });
        out.push(a);
      }
      const o = f.box('uml-lifeline', x, origin.y, 140, height, { text: n.label });
      ids.set(n.id, o);
      out.push(o);
    });
    p.edges.forEach((e, i) => {
      const a = ids.get(e.from)!, b = ids.get(e.to)!;
      const y = origin.y + 90 + i * 56;
      const self = a === b;
      const from: End = { kind: 'free', x: a.x + a.w / 2, y };
      const to: End = { kind: 'free', x: self ? a.x + a.w / 2 + 60 : b.x + b.w / 2, y: self ? y + 24 : y };
      const rel = RELATIONS[e.relation ?? 'message'];
      out.push(f.connector(from, to, { route: self ? 'elbow' : 'straight', relation: e.relation, startHead: rel.startHead, endHead: rel.endHead, dash: rel.dash, label: e.label }));
    });
    return out;
  }

  // ranks
  const rank = new Map<string, number>();
  const incoming = new Map<string, number>();
  p.nodes.forEach((n) => incoming.set(n.id, 0));
  p.edges.forEach((e) => incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1));
  const order = p.nodes.map((n) => n.id);
  // longest-path ranking with an iteration cap so cycles terminate
  order.forEach((id) => rank.set(id, 0));
  for (let iter = 0; iter < order.length; iter++) {
    let changed = false;
    for (const e of p.edges) {
      if (e.from === e.to) continue;
      const r = (rank.get(e.from) ?? 0) + 1;
      if (r > (rank.get(e.to) ?? 0) && r < order.length) {
        rank.set(e.to, r);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // For class diagrams, parents (generalization targets) go above children.
  if (p.type === 'class') {
    const r2 = new Map<string, number>(order.map((id) => [id, 0]));
    for (let iter = 0; iter < order.length; iter++) {
      let changed = false;
      for (const e of p.edges) {
        const [parent, child] = e.relation === 'generalization' || e.relation === 'realization' ? [e.to, e.from] : [e.from, e.to];
        const r = (r2.get(parent) ?? 0) + 1;
        if (r > (r2.get(child) ?? 0) && r < order.length) { r2.set(child, r); changed = true; }
      }
      if (!changed) break;
    }
    r2.forEach((v, k) => rank.set(k, v));
  }

  const layers: string[][] = [];
  for (const id of order) {
    const r = rank.get(id) ?? 0;
    (layers[r] ||= []).push(id);
  }
  const sizeOf = (n: Parsed['nodes'][number]) => {
    if (n.kind === 'initial') return { w: 28, h: 28 };
    if (n.kind === 'final') return { w: 32, h: 32 };
    if (n.kind === 'class') {
      const lines = [n.label, ...(n.members || []).map(memberToString)];
      const w = Math.min(320, Math.max(180, ...lines.map((l) => measure(l, fontCss('satoshi', 14, 600)) + 32)));
      const attrs = (n.members || []).filter((m) => !m.name.includes('('));
      const ops = (n.members || []).filter((m) => m.name.includes('('));
      return { w, h: classHeight({ attributes: attrs, operations: ops, stereotype: n.stereotype } as BaseObj) };
    }
    const tw = measure(n.label, fontCss('satoshi', 16, 500));
    const base = n.shape === 'diamond' ? 1.6 : n.shape === 'ellipse' ? 1.4 : 1;
    return { w: Math.min(280, Math.max(140, tw * base + 48)), h: n.shape === 'diamond' ? 104 : 72 };
  };
  const gapMain = p.type === 'class' ? 110 : 90, gapCross = 64;
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  let main = 0;
  layers.forEach((layer) => {
    if (!layer) return;
    const sizes = layer.map((id) => sizeOf(byId.get(id)!));
    const thickness = Math.max(...sizes.map((s) => (p.direction === 'TB' ? s.h : s.w)));
    const total = sizes.reduce((s, z) => s + (p.direction === 'TB' ? z.w : z.h), 0) + gapCross * (layer.length - 1);
    let cross = -total / 2;
    layer.forEach((id, i) => {
      const n = byId.get(id)!;
      const s = sizes[i];
      const x = p.direction === 'TB' ? origin.x + cross : origin.x + main + (thickness - s.w) / 2;
      const y = p.direction === 'TB' ? origin.y + main + (thickness - s.h) / 2 : origin.y + cross;
      let o: BaseObj;
      if (n.kind === 'class') {
        o = f.box('uml-class', x, y, s.w, s.h, {
          text: n.label, stereotype: n.stereotype,
          attributes: (n.members || []).filter((m) => !m.name.includes('(')),
          operations: (n.members || []).filter((m) => m.name.includes('(')),
        });
      } else if (n.kind === 'initial') o = f.box('uml-initial', x, y, s.w, s.h, {});
      else if (n.kind === 'final') o = f.box('uml-final', x, y, s.w, s.h, {});
      else if (n.kind === 'state') o = f.box('uml-state', x, y, s.w, s.h, { text: n.label });
      else o = f.box('shape', x, y, s.w, s.h, { kind: n.shape, text: n.label });
      ids.set(id, o);
      out.push(o);
      cross += (p.direction === 'TB' ? s.w : s.h) + gapCross;
    });
    main += thickness + gapMain;
  });

  for (const e of p.edges) {
    const a = ids.get(e.from), b = ids.get(e.to);
    if (!a || !b) continue;
    const rel = e.relation ? RELATIONS[e.relation] : null;
    out.push(f.connector({ kind: 'bound', id: a.id, anchor: 'auto' }, { kind: 'bound', id: b.id, anchor: 'auto' }, {
      route: 'elbow', relation: e.relation, label: e.label,
      startHead: rel ? rel.startHead : e.startHead ?? 'none',
      endHead: rel ? rel.endHead : e.endHead ?? 'arrow',
      dash: rel ? rel.dash : e.dashed ? 'dashed' : 'solid',
    }));
  }
  return out;
}

// ---------------------------------------------------------------- export

const SHAPE_TO_MERMAID: Partial<Record<ShapeKind, [string, string]>> = {
  rect: ['[', ']'], rounded: ['(', ')'], ellipse: ['((', '))'], diamond: ['{', '}'], terminator: ['([', '])'],
  cylinder: ['[(', ')]'], hexagon: ['{{', '}}'], predefined: ['[[', ']]'], parallelogram: ['[/', '/]'],
};

const REL_TO_MERMAID: Record<string, string> = {
  generalization: '--|>', realization: '..|>', composition: '*--', aggregation: 'o--',
  directed: '-->', dependency: '..>', association: '--',
};

export function toMermaid(objs: Obj[]): string {
  const boxes = objs.filter(isBox);
  const conns = objs.filter(isConnector);
  const idOf = new Map<string, string>();
  boxes.forEach((o, i) => idOf.set(o.id, `n${i + 1}`));
  const safe = (s: string) => s.replace(/["\n]/g, ' ').trim() || ' ';
  const classes = boxes.filter((o) => o.type === 'uml-class');
  if (classes.length) {
    const lines = ['classDiagram'];
    for (const c of classes) {
      const name = (c.text || 'Class').replace(/\s+/g, '_');
      idOf.set(c.id, name);
      lines.push(`  class ${name} {`);
      if (c.stereotype) lines.push(`    <<${c.stereotype}>>`);
      for (const m of [...(c.attributes || []), ...(c.operations || [])]) lines.push(`    ${memberToString(m)}${m.isStatic ? '$' : ''}${m.isAbstract ? '*' : ''}`);
      lines.push('  }');
    }
    for (const c of conns) {
      if (c.from.kind !== 'bound' || c.to.kind !== 'bound') continue;
      const a = idOf.get(c.from.id), b = idOf.get(c.to.id);
      if (!a || !b) continue;
      const arrow = REL_TO_MERMAID[c.relation ?? 'association'] ?? '-->';
      lines.push(`  ${a} ${arrow} ${b}${c.label ? ` : ${safe(c.label)}` : ''}`);
    }
    return lines.join('\n');
  }
  const lines = ['flowchart TD'];
  for (const o of boxes) {
    if (o.type === 'frame' || o.type === 'path' || o.type === 'icon' || o.type === 'container' || o.type === 'lane' || o.type === 'card') continue;
    const [l, r] = (o.type === 'shape' && SHAPE_TO_MERMAID[o.kind || 'rect']) || ['(', ')'];
    lines.push(`  ${idOf.get(o.id)}${l}"${safe(o.text || '')}"${r}`);
  }
  for (const c of conns) {
    if (c.from.kind !== 'bound' || c.to.kind !== 'bound') continue;
    const a = idOf.get(c.from.id), b = idOf.get(c.to.id);
    if (!a || !b) continue;
    const arrow = c.dash === 'dashed' ? '-.->' : c.endHead === 'none' ? '---' : '-->';
    lines.push(`  ${a} ${arrow}${c.label ? `|${safe(c.label)}|` : ''} ${b}`);
  }
  return lines.join('\n');
}
