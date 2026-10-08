/**
 * Focus requests: one person asks the others to look at their view, or says they moved to a step. The request travels
 * on the sender's awareness state (never in the shared document) and moves nobody: each recipient decides what to do.
 * This module is the logic only (checking, rate limiting, muting, view maths), with no DOM and no Yjs.
 */

/** A person can send one request every 10 seconds, and a recipient ignores a repeat that comes sooner. */
export const COOLDOWN_MS = 10_000;
/** A request older than this, or still in the sender's awareness state after it, is ignored. The sender clears it then. */
export const REQUEST_TTL_MS = 30_000;
/** How long the prompt stays on screen when nobody answers it. */
export const PROMPT_MS = 20_000;
/** Clocks differ a little between devices: a request up to this far ahead of ours still counts. */
export const FUTURE_SKEW_MS = 5_000;
/** The most people one person can mute on one board. */
export const MAX_MUTED = 200;

export type FocusKind = 'view' | 'step';

export interface FocusPerson {
  id: string;
  name: string;
  /** A hex colour, or empty when the sender sent something else. */
  color: string;
}

export interface FocusRequest {
  id: string;
  /** World coordinates of the centre of the sender's view, and the zoom. For a step: the centre of its frame. */
  x: number;
  y: number;
  zoom: number;
  ts: number;
  from: FocusPerson;
  kind: FocusKind;
  stepId?: string;
  stepTitle?: string;
}

const MAX_NAME = 40;
const MAX_TITLE = 80;
const MAX_ID = 100;
const MAX_COORD = 10_000_000;
const MAX_ZOOM = 64;

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const hex = (v: unknown): string => (typeof v === 'string' && /^#[\da-f]{3,8}$/i.test(v) ? v : '');
const idOf = (v: unknown): string => (typeof v === 'string' && v.length > 0 && v.length <= MAX_ID ? v : '');

/** Reads a request off an awareness state. Anything malformed is null; text is trimmed and capped. */
export function parseRequest(raw: unknown): FocusRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = idOf(r.id);
  if (!id || !finite(r.x) || !finite(r.y) || !finite(r.zoom) || !finite(r.ts)) return null;
  if (Math.abs(r.x) > MAX_COORD || Math.abs(r.y) > MAX_COORD || r.zoom <= 0 || r.zoom > MAX_ZOOM) return null;
  if (r.kind !== 'view' && r.kind !== 'step') return null;
  if (!r.from || typeof r.from !== 'object') return null;
  const f = r.from as Record<string, unknown>;
  const fromId = idOf(f.id);
  if (!fromId) return null;
  const req: FocusRequest = {
    id, x: r.x, y: r.y, zoom: r.zoom, ts: r.ts, kind: r.kind,
    from: { id: fromId, name: text(f.name, MAX_NAME) || 'Someone', color: hex(f.color) },
  };
  if (r.kind === 'step') {
    const title = text(r.stepTitle, MAX_TITLE);
    const stepId = idOf(r.stepId);
    if (!title || !stepId) return null;
    req.stepTitle = title;
    req.stepId = stepId;
  }
  return req;
}

export interface RequestInput {
  id: string;
  now: number;
  from: { id: string; name: string; color: string };
  /** The centre of the view, or of the step's frame. */
  view: { x: number; y: number; zoom: number };
  step?: { id: string; title: string };
}

/** The value a sender puts on its awareness state. A step makes it a step request. */
export function buildRequest(i: RequestInput): FocusRequest {
  const req: FocusRequest = {
    id: i.id, x: i.view.x, y: i.view.y, zoom: i.view.zoom, ts: i.now, kind: i.step ? 'step' : 'view',
    from: { id: i.from.id, name: i.from.name, color: i.from.color },
  };
  if (i.step) {
    req.stepId = i.step.id;
    req.stepTitle = i.step.title;
  }
  return req;
}

/** What the prompt says. */
export function requestText(req: FocusRequest): string {
  return req.kind === 'step' ? `${req.from.name} moved to step "${req.stepTitle}"` : `${req.from.name} asks you to look at their view`;
}

// ---------------------------------------------------------------- sender side

/** Milliseconds until this person may ask again; 0 when they may now. A clock that went backwards never waits longer than the cooldown. */
export function cooldownLeft(lastAskAt: number | null, now: number): number {
  if (lastAskAt === null) return 0;
  return Math.min(COOLDOWN_MS, Math.max(0, COOLDOWN_MS - (now - lastAskAt)));
}

/** The tooltip of the disabled button. */
export function cooldownLabel(ms: number): string {
  return `Ask again in ${Math.max(1, Math.ceil(ms / 1000))} s`;
}

// ---------------------------------------------------------------- recipient side

export type Ignored = 'own' | 'duplicate' | 'future' | 'stale' | 'muted' | 'following' | 'rate';
export type Verdict = { show: true } | { show: false; reason: Ignored };

export interface RecipientContext {
  now: number;
  /** This person's id. A request from another tab of the same person is ignored. */
  me: string;
  muted: readonly MutedPerson[];
  /** The person this tab follows now. Their requests are not needed: following already moves this view. */
  following: string | null;
}

/** Requests that repeat one another: the same person and kind, and for a step the same step. */
export function rateKey(req: FocusRequest): string {
  return req.kind === 'step' ? `${req.from.id}:step:${req.stepId}` : `${req.from.id}:view`;
}

/**
 * Decides which requests become a prompt. It remembers the ids it has seen, so a request that stays on the sender's
 * state while other fields change is judged once, and the time of each prompt, so a repeat inside the cooldown is ignored.
 */
export class RequestTracker {
  private seen = new Map<string, number>();
  private shown = new Map<string, number>();

  /** True when this request id was already judged, before it is even read. */
  hasSeen(id: string): boolean {
    return this.seen.has(id);
  }

  evaluate(req: FocusRequest, ctx: RecipientContext): Verdict {
    this.prune(ctx.now);
    if (this.seen.has(req.id)) return { show: false, reason: 'duplicate' };
    this.seen.set(req.id, ctx.now);
    if (req.from.id === ctx.me) return { show: false, reason: 'own' };
    if (req.ts > ctx.now + FUTURE_SKEW_MS) return { show: false, reason: 'future' };
    if (ctx.now - req.ts > REQUEST_TTL_MS) return { show: false, reason: 'stale' };
    if (isMuted(ctx.muted, req.from.id)) return { show: false, reason: 'muted' };
    if (ctx.following === req.from.id) return { show: false, reason: 'following' };
    const key = rateKey(req);
    const last = this.shown.get(key);
    if (last !== undefined && ctx.now - last < COOLDOWN_MS) return { show: false, reason: 'rate' };
    this.shown.set(key, ctx.now);
    return { show: true };
  }

  private prune(now: number) {
    for (const m of [this.seen, this.shown]) {
      for (const [k, t] of m) if (now - t > REQUEST_TTL_MS * 2) m.delete(k);
    }
  }
}

/** How long a prompt stays: 20 seconds, less when the request is already old (a person who just joined). */
export function promptLifetime(req: FocusRequest, now: number): number {
  return Math.max(0, Math.min(PROMPT_MS, REQUEST_TTL_MS - (now - req.ts)));
}

// ---------------------------------------------------------------- muting

export interface MutedPerson {
  id: string;
  /** The name when muted, so the list can show who it is while they are offline. */
  name: string;
}

export const mutedKey = (userId: string, boardId: string) => `driftboard:focus-muted:${userId}:${boardId}`;

/** Reads what was stored. Anything unreadable mutes nobody. */
export function parseMuted(raw: string | null): MutedPerson[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: MutedPerson[] = [];
    for (const e of v) {
      if (!e || typeof e !== 'object') continue;
      const id = idOf((e as Record<string, unknown>).id);
      if (!id || out.some((p) => p.id === id)) continue;
      out.push({ id, name: text((e as Record<string, unknown>).name, MAX_NAME) || 'Someone' });
    }
    return out.slice(-MAX_MUTED);
  } catch {
    return [];
  }
}

/** The stored text, or null when nobody is muted. */
export function serializeMuted(list: readonly MutedPerson[]): string | null {
  return list.length ? JSON.stringify(list.map((p) => ({ id: p.id, name: p.name }))) : null;
}

export const isMuted = (list: readonly MutedPerson[], id: string) => list.some((p) => p.id === id);

/** Adds a person (or refreshes their name). The newest stay when the list is full. */
export function mutePerson(list: readonly MutedPerson[], person: MutedPerson): MutedPerson[] {
  return [...list.filter((p) => p.id !== person.id), { id: person.id, name: text(person.name, MAX_NAME) || 'Someone' }].slice(-MAX_MUTED);
}

export const unmutePerson = (list: readonly MutedPerson[], id: string): MutedPerson[] => list.filter((p) => p.id !== id);

/** Storage can be blocked or full. Then nobody is muted, and nothing is saved. */
export function loadMuted(userId: string, boardId: string): MutedPerson[] {
  try {
    return parseMuted(localStorage.getItem(mutedKey(userId, boardId)));
  } catch {
    return [];
  }
}

export function saveMuted(userId: string, boardId: string, list: readonly MutedPerson[]): void {
  try {
    const raw = serializeMuted(list);
    if (raw) localStorage.setItem(mutedKey(userId, boardId), raw);
    else localStorage.removeItem(mutedKey(userId, boardId));
  } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------- following

/** A person's view as it travels on awareness while someone follows them: the centre and the zoom. */
export interface View { x: number; y: number; zoom: number }

export function parseView(raw: unknown): View | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (!finite(v.x) || !finite(v.y) || !finite(v.zoom)) return null;
  if (Math.abs(v.x) > MAX_COORD || Math.abs(v.y) > MAX_COORD || v.zoom <= 0 || v.zoom > MAX_ZOOM) return null;
  return { x: v.x, y: v.y, zoom: v.zoom };
}

/** The camera (top-left corner and zoom) that puts a view's centre in the middle of a screen of this size. */
export function viewToCamera(v: View, size: { w: number; h: number }): { x: number; y: number; zoom: number } {
  return { zoom: v.zoom, x: v.x - size.w / 2 / v.zoom, y: v.y - size.h / 2 / v.zoom };
}

/** The view a camera shows: the centre of the screen and the zoom, rounded so tiny drifts are not sent. */
export function cameraToView(cam: { x: number; y: number; zoom: number }, size: { w: number; h: number }): View {
  const round = (n: number, d: number) => Math.round(n * d) / d;
  return { x: round(cam.x + size.w / 2 / cam.zoom, 10), y: round(cam.y + size.h / 2 / cam.zoom, 10), zoom: round(cam.zoom, 10_000) };
}

/** Whether two cameras are exactly the same. A follower stops when the camera is not the one it left. */
export function sameCamera(a: { x: number; y: number; zoom: number }, b: { x: number; y: number; zoom: number }): boolean {
  return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}

/** Whether a new view is worth moving to: more than half a screen pixel away, or a different zoom. */
export function viewDiffers(a: View, b: View): boolean {
  return Math.abs(a.x - b.x) * a.zoom > 0.5 || Math.abs(a.y - b.y) * a.zoom > 0.5 || Math.abs(a.zoom / b.zoom - 1) > 0.001;
}

/** True when some other client's awareness state says it follows this one. Only then does a client send its view. */
export function isFollowedBy(states: Iterable<[number, unknown]>, clientId: number): boolean {
  for (const [id, st] of states) {
    if (id !== clientId && st && typeof st === 'object' && (st as { following?: unknown }).following === clientId) return true;
  }
  return false;
}
