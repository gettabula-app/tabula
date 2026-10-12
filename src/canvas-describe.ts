import type { BaseObj, ConnectorObj, Obj } from './types';
import { isConnector } from './types';
import { TYPE_LABEL } from './layers';
import { STICKY_COLORS } from './palette';

/**
 * What a screen reader is told about an object in the canvas outline (docs/canvas-keyboard.md): a name built in a fixed order,
 * most useful first, and a description with the rest. Pure: it reads the object and a lookup, so every string is tested.
 */
export interface Description {
  name: string;
  description: string;
}

const NAME_TEXT_MAX = 120;

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

const cut = (text: string) => (text.length > NAME_TEXT_MAX ? `${text.slice(0, NAME_TEXT_MAX - 1)}…` : text);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The sticky colour's name when the fill is one of the palette's. */
function stickyColour(o: BaseObj): string | null {
  const fill = typeof o.fill === 'string' ? o.fill.toLowerCase() : '';
  const hit = STICKY_COLORS.find((c) => c.fill.toLowerCase() === fill);
  return hit ? hit.name.toLowerCase() : null;
}

export interface DescribeContext {
  get(id: string): Obj | undefined;
  /** How many objects are inside this one. */
  childCount(id: string): number;
}

/** The label of an object an end of a connector is bound to, for "from A to B". */
function endName(o: ConnectorObj, side: 'from' | 'to', ctx: DescribeContext): string {
  const end = o[side];
  if (end.kind !== 'bound') return 'empty canvas';
  const target = ctx.get(end.id);
  if (!target) return 'a removed object';
  const text = oneLine(String((target as { text?: unknown; name?: unknown }).text ?? (target as { name?: unknown }).name ?? ''));
  return text ? cut(text) : (TYPE_LABEL[target.type] ?? 'object').toLowerCase();
}

export function describeObject(o: Obj, ctx: DescribeContext): Description {
  const state: string[] = [];
  if (o.locked) state.push('locked');
  const rest: string[] = [];
  const parent = o.parent ? ctx.get(o.parent) : undefined;
  if (parent) {
    const parentName = oneLine(String((parent as { name?: unknown }).name ?? ''));
    rest.push(`In ${(TYPE_LABEL[parent.type] ?? 'group').toLowerCase()}${parentName ? ` ${parentName}` : ''}.`);
  }
  const suffix = state.length ? `, ${state.join(', ')}` : '';
  const text = oneLine(String((o as { text?: unknown }).text ?? ''));
  const quoted = text ? `, "${cut(text)}"` : '';
  if (text.length > NAME_TEXT_MAX) rest.unshift(`${text}`);

  if (isConnector(o)) {
    const label = oneLine(o.label ?? '');
    return {
      name: `Connector from ${endName(o, 'from', ctx)} to ${endName(o, 'to', ctx)}${label ? `, "${cut(label)}"` : ''}${suffix}`,
      description: rest.join(' '),
    };
  }
  switch (o.type) {
    case 'sticky': {
      const colour = stickyColour(o as BaseObj);
      return { name: `Sticky note${colour ? `, ${colour}` : ''}${quoted}${suffix}`, description: rest.join(' ') };
    }
    case 'frame': case 'group': case 'container': case 'lane': {
      const named = oneLine(String((o as { name?: unknown }).name ?? ''));
      const kind = TYPE_LABEL[o.type];
      return { name: `${kind}${named ? ` ${named}` : ''}, ${plural(ctx.childCount(o.id), 'item')}${suffix}`, description: rest.join(' ') };
    }
    case 'image': {
      const alt = oneLine(String((o as { alt?: unknown }).alt ?? ''));
      return {
        name: `Image, ${alt ? `"${cut(alt)}"` : 'no description'}${suffix}`,
        description: [...rest, ...(alt ? [] : ['No description yet.'])].join(' '),
      };
    }
    case 'path':
      return { name: `Drawing${suffix}`, description: rest.join(' ') };
    case 'icon': {
      const label = oneLine(String((o as { name?: unknown; alt?: unknown }).alt ?? (o as { name?: unknown }).name ?? ''));
      return { name: `Icon${label ? `, ${label}` : ''}${suffix}`, description: rest.join(' ') };
    }
    default: {
      const kind = TYPE_LABEL[o.type] ?? 'Object';
      return { name: `${kind}${quoted}${suffix}`, description: rest.join(' ') };
    }
  }
}

/** "Whiteboard, 14 objects" and the empty board's hint. */
export function boardLabel(count: number): string {
  return count === 0 ? 'Whiteboard, 0 objects. Press N to add a sticky note.' : `Whiteboard, ${plural(count, 'object')}`;
}
