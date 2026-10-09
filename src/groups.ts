import type { BaseObj, Group, Id, Obj, Rect } from './types';
import { boxBounds, unionRects } from './geometry';
import { isBox } from './types';

export const GROUP_MAX_DEPTH = 8;
export const GROUP_MAX_MEMBERS = 500;
export const GROUP_MAX_PER_BOARD = 500;
export const GROUP_NAME_MAX = 80;

export type GetObject = (id: Id) => Obj | undefined;
export type ListChildren = (id: Id) => readonly Obj[];

export const isGroup = (o: Obj | undefined): o is Group => !!o && o.type === 'group';

function parentWalk(o: Obj, get: GetObject): { ancestors: Obj[]; repeated?: Obj } {
  const ancestors: Obj[] = [];
  const seen = new Set<Id>([o.id]);
  let current = o;
  while (current.parent) {
    const id = current.parent;
    const parent = get(id);
    if (!parent) break;
    if (seen.has(id)) return { ancestors, repeated: parent };
    ancestors.push(parent);
    seen.add(id);
    current = parent;
  }
  return { ancestors };
}

/** Parent objects, nearest first. Missing parents and repeated ids end the walk. */
export function ancestorsOf(o: Obj, get: GetObject): Obj[] {
  return parentWalk(o, get).ancestors;
}

/** The highest group in the object's parent chain, or the repeated group that closes a malformed cycle. */
export function outermostGroup(o: Obj, get: GetObject): Group | undefined {
  const walk = parentWalk(o, get);
  if (isGroup(walk.repeated)) return walk.repeated;
  const groups = [o, ...walk.ancestors].filter(isGroup);
  return groups.at(-1);
}

/** All descendants, including nested groups, in the order supplied by `childrenOf`. */
export function descendantsOf(id: Id, get: GetObject, childrenOf: ListChildren): Obj[] {
  const out: Obj[] = [];
  const seen = new Set<Id>([id]);
  const walk = (parentId: Id) => {
    for (const child of childrenOf(parentId)) {
      if (child.parent !== parentId || seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      if (isGroup(child)) walk(child.id);
    }
  };
  if (get(id)) walk(id);
  return out;
}

/** The nearest frame ancestor, following parent links through any number of groups. */
export function frameOf(o: Obj, get: GetObject): BaseObj | undefined {
  return parentWalk(o, get).ancestors.find((parent): parent is BaseObj => parent.type === 'frame');
}

/** True when the object or one of its group ancestors is locked. */
export function effectiveLocked(o: Obj, get: GetObject): boolean {
  if (o.locked === true) return true;
  return ancestorsOf(o, get).some((parent) => isGroup(parent) && parent.locked === true);
}

/** Number of group levels containing this object, including the object itself when it is a group. */
export function groupDepth(o: Obj, get: GetObject): number {
  return [o, ...ancestorsOf(o, get)].filter(isGroup).length;
}

export function groupFitsLimits(input: { depth: number; members: number; groups: number; name?: string }): boolean {
  return input.depth >= 1 && input.depth <= GROUP_MAX_DEPTH && input.members >= 0 && input.members <= GROUP_MAX_MEMBERS &&
    input.groups >= 0 && input.groups <= GROUP_MAX_PER_BOARD && (input.name === undefined || input.name.length <= GROUP_NAME_MAX);
}

/** Union of visible leaf members; nested groups are walked and connectors and frames do not contribute. */
export function membersBounds(
  group: Group,
  get: GetObject,
  childrenOf: ListChildren,
  visible: (o: Obj) => boolean = () => true,
  boundsOf: (o: BaseObj) => Rect = boxBounds,
): Rect | null {
  const rects: Rect[] = [];
  const seen = new Set<Id>([group.id]);
  const walk = (parentId: Id) => {
    for (const child of childrenOf(parentId)) {
      if (child.parent !== parentId || seen.has(child.id)) continue;
      seen.add(child.id);
      if (!visible(child)) continue;
      if (isGroup(child)) {
        walk(child.id);
      } else if (isBox(child) && child.type !== 'frame') {
        rects.push(boundsOf(child));
      }
    }
  };
  if (get(group.id)) walk(group.id);
  return unionRects(rects);
}
