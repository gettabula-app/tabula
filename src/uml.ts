import type { BaseObj, Dash, Head, Member, UmlRelation, UmlType } from './types';

export const RELATIONS: Record<UmlRelation, { label: string; startHead: Head; endHead: Head; dash: Dash; text?: string }> = {
  association: { label: 'Association', startHead: 'none', endHead: 'none', dash: 'solid' },
  directed: { label: 'Directed association', startHead: 'none', endHead: 'open', dash: 'solid' },
  generalization: { label: 'Generalization (inherits)', startHead: 'none', endHead: 'triangle', dash: 'solid' },
  realization: { label: 'Realization (implements)', startHead: 'none', endHead: 'triangle', dash: 'dashed' },
  dependency: { label: 'Dependency', startHead: 'none', endHead: 'open', dash: 'dashed' },
  aggregation: { label: 'Aggregation', startHead: 'diamond-open', endHead: 'none', dash: 'solid' },
  composition: { label: 'Composition', startHead: 'diamond', endHead: 'none', dash: 'solid' },
  message: { label: 'Sync message', startHead: 'none', endHead: 'arrow', dash: 'solid' },
  async: { label: 'Async message', startHead: 'none', endHead: 'open', dash: 'solid' },
  reply: { label: 'Reply', startHead: 'none', endHead: 'open', dash: 'dashed' },
  include: { label: 'Include', startHead: 'none', endHead: 'open', dash: 'dashed', text: '«include»' },
  extend: { label: 'Extend', startHead: 'none', endHead: 'open', dash: 'dashed', text: '«extend»' },
  transition: { label: 'Transition', startHead: 'none', endHead: 'arrow', dash: 'solid' },
};

export interface UmlElementDef {
  type: UmlType;
  label: string;
  w: number;
  h: number;
  defaults?: Partial<BaseObj>;
}

export const UML_ELEMENTS: UmlElementDef[] = [
  {
    type: 'uml-class', label: 'Class', w: 220, h: 120,
    defaults: {
      text: 'Order',
      attributes: [
        { visibility: '-', name: 'id', type: 'UUID' },
        { visibility: '-', name: 'total', type: 'Money' },
      ],
      operations: [{ visibility: '+', name: 'submit()', type: 'void' }],
    },
  },
  {
    type: 'uml-class', label: 'Interface', w: 220, h: 100,
    defaults: { text: 'PaymentGateway', stereotype: 'interface', attributes: [], operations: [{ visibility: '+', name: 'charge(amount)', type: 'Receipt' }] },
  },
  {
    type: 'uml-class', label: 'Abstract class', w: 220, h: 100,
    defaults: { text: 'Shape', stereotype: 'abstract', attributes: [], operations: [{ visibility: '+', name: 'area()', type: 'number', isAbstract: true }] },
  },
  {
    type: 'uml-class', label: 'Enum', w: 180, h: 110,
    defaults: { text: 'Status', stereotype: 'enumeration', attributes: [{ visibility: '', name: 'DRAFT', type: '' }, { visibility: '', name: 'PAID', type: '' }], operations: [] },
  },
  { type: 'uml-actor', label: 'Actor', w: 60, h: 110, defaults: { text: 'Customer' } },
  { type: 'uml-usecase', label: 'Use case', w: 180, h: 72, defaults: { text: 'Place order' } },
  { type: 'uml-lifeline', label: 'Lifeline', w: 140, h: 360, defaults: { text: ':OrderService' } },
  { type: 'uml-state', label: 'State', w: 160, h: 64, defaults: { text: 'Pending' } },
  { type: 'uml-initial', label: 'Initial node', w: 28, h: 28 },
  { type: 'uml-final', label: 'Final node', w: 32, h: 32 },
  { type: 'uml-package', label: 'Package / boundary', w: 320, h: 220, defaults: { text: 'billing' } },
  { type: 'uml-component', label: 'Component', w: 200, h: 90, defaults: { text: 'Checkout API' } },
  { type: 'uml-note', label: 'Note', w: 180, h: 90, defaults: { text: 'Totals are recalculated on every change.' } },
];

export function memberToString(m: Member): string {
  const vis = m.visibility ? m.visibility + ' ' : '';
  const type = m.type ? `: ${m.type}` : '';
  return `${vis}${m.name}${type}`;
}

/**
 * Class boxes are edited as plain text:
 *   «interface» (optional first line)
 *   ClassName
 *   --
 *   - attribute: Type
 *   --
 *   + operation(): Type
 * `static` and `abstract` prefixes set the member flags.
 */
export function formatClass(o: BaseObj): string {
  const lines: string[] = [];
  if (o.stereotype) lines.push(`«${o.stereotype}»`);
  lines.push(o.text || 'Class');
  lines.push('--');
  for (const m of o.attributes || []) lines.push(prefixFlags(m) + memberToString(m));
  lines.push('--');
  for (const m of o.operations || []) lines.push(prefixFlags(m) + memberToString(m));
  return lines.join('\n');
}

const prefixFlags = (m: Member) => (m.isStatic ? 'static ' : '') + (m.isAbstract ? 'abstract ' : '');

export function parseMember(line: string): Member {
  let s = line.trim();
  let isStatic = false, isAbstract = false;
  for (;;) {
    if (s.startsWith('static ')) { isStatic = true; s = s.slice(7).trim(); continue; }
    if (s.startsWith('abstract ')) { isAbstract = true; s = s.slice(9).trim(); continue; }
    break;
  }
  let visibility: Member['visibility'] = '';
  if (/^[+\-#~]/.test(s)) {
    visibility = s[0] as Member['visibility'];
    s = s.slice(1).trim();
  }
  // type after the last ':' that is outside parentheses
  let depth = 0, cut = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ':' && depth === 0) cut = i;
  }
  let name = (cut >= 0 ? s.slice(0, cut) : s).trim();
  let type = cut >= 0 ? s.slice(cut + 1).trim() : '';
  // Mermaid style "speak() void": return type after the parameter list
  const trailing = cut < 0 ? name.match(/^(.+\))\s+(\S+)$/) : null;
  if (trailing) {
    name = trailing[1];
    type = trailing[2];
  }
  const m: Member = { visibility, name, type };
  if (isStatic) m.isStatic = true;
  if (isAbstract) m.isAbstract = true;
  return m;
}

export function parseClass(text: string): Pick<BaseObj, 'text' | 'stereotype' | 'attributes' | 'operations'> {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  let stereotype: string | undefined;
  const st = lines[i]?.trim().match(/^(?:«|<<)(.+?)(?:»|>>)$/);
  if (st) {
    stereotype = st[1].trim();
    i++;
  }
  const name = (lines[i] ?? 'Class').trim() || 'Class';
  i++;
  const sections: string[][] = [[]];
  for (; i < lines.length; i++) {
    if (/^\s*-{2,}\s*$/.test(lines[i])) {
      sections.push([]);
      continue;
    }
    if (lines[i].trim()) sections[sections.length - 1].push(lines[i]);
  }
  // sections[0] holds anything typed between the name and the first divider
  const attrsLines = sections.length > 1 ? [...sections[0], ...sections[1]] : sections[0];
  const opsLines = sections.slice(2).flat();
  const attributes = attrsLines.map(parseMember);
  const operations = opsLines.map(parseMember);
  // A member with parentheses typed into the attribute section is an operation.
  const moved = attributes.filter((m) => m.name.includes('('));
  return {
    text: name,
    stereotype,
    attributes: attributes.filter((m) => !m.name.includes('(')),
    operations: [...moved, ...operations],
  };
}

export const CLASS_LINE = 18;
export const CLASS_HEADER = (o: BaseObj) => (o.stereotype ? 46 : 32);

/** Height a class box needs for its content. */
export function classHeight(o: BaseObj): number {
  const a = Math.max(1, (o.attributes || []).length);
  const ops = Math.max(1, (o.operations || []).length);
  return CLASS_HEADER(o) + 10 + a * CLASS_LINE + 10 + ops * CLASS_LINE + 6;
}
