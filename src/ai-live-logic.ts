import type { AiProposal, CreateLayout, GroupLayout, Layout, Rect } from './ai-apply';
import { plural, settledMessage } from './ai-bar-logic';
import { presenceLine, type LiveRun, type RunPerson, type RunTarget, type SettledRun } from './ai-runs';
import { fontFamily } from './fonts';
import { labelBox, styleOf, textBlock } from './markup';
import { CANVAS_INK, INK, USER_COLORS, luminance, mix } from './palette';
import { escapeXml } from './text';
import type { BaseObj } from './types';

// What the board draws and says for the AI runs of the people on it (docs/ai-toolbar.md, "Multiplayer (TAB-141)"): the ghosts
// of a preview, the label rows and where they go, the words of the toasts, and who is who. Pure: no DOM. A proposal is model
// output, so every piece of text on its way into markup is escaped, and the ghosts are only ever text, never markup.

// ---------------------------------------------------------------- whose run is it

const sameColor = (a: string | null, b: string | null): boolean => !!a && !!b && a.toUpperCase() === b.toUpperCase();

/**
 * The person's own run: in accounts mode the relay names them (`by.id` is the account), in open mode `by.id` is null and the
 * run is theirs when the bar says so (`barRunId`, from the stream of their own request). A request that has just been sent
 * has no id yet (`starting`): the run that appears with the name and colour it sent is the person's own, so it never flashes
 * as someone else's.
 */
export function isMine(
  run: Pick<LiveRun, 'id' | 'by' | 'status'>,
  me: string | null,
  barRunId: string | null,
  starting: { name: string; color: string } | null = null,
): boolean {
  if ((!!me && run.by.id === me) || (barRunId !== null && run.id === barRunId)) return true;
  return !!starting && run.status === 'running' && run.by.id === null && run.by.name === starting.name && sameColor(run.by.color, starting.color);
}

/** Others' previews oldest first, then the person's own on top (docs/ai-toolbar.md, "Two previews at once"). */
export function stacked<T extends LiveRun>(runs: readonly T[], mine: (run: T) => boolean): T[] {
  return [...runs.filter((r) => !mine(r)), ...runs.filter(mine)];
}

function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/** A person's colour: the one they sent (their cursor colour), else one of the cursor colours picked from their id. */
export function personColor(run: Pick<LiveRun, 'id' | 'by'>): string {
  return run.by.color ?? USER_COLORS[hash(run.by.id ?? run.id) % USER_COLORS.length];
}

// ---------------------------------------------------------------- label colours

const MIN_LABEL_CONTRAST = 4.5;
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * The fill and the text colour of a person's label: white or the ink, whichever contrasts more with the person's colour. A
 * fill that still misses 4.5:1 is darkened a tenth at a time toward the ink (or lightened toward white under dark text), so
 * the red `#D64545` becomes `color-mix(#D64545 90%, #18212B)`, 5.04:1 against white.
 */
export function labelColors(color: string): { fill: string; ink: string } {
  const white = '#FFFFFF';
  const ink = contrast(color, white) >= contrast(color, INK) ? white : INK;
  const toward = ink === white ? INK : white;
  let fill = color;
  for (let step = 1; step <= 4 && contrast(fill, ink) < MIN_LABEL_CONTRAST; step++) fill = mix(color, toward, step / 10);
  return { fill, ink };
}

// ---------------------------------------------------------------- ghosts

/** Room kept between a preview's outline and the stickies inside it, in board units. */
export const PREVIEW_PAD = 8;
/** The strip above a ghost frame that its title takes; a label row never covers it. */
export const TITLE_BAND = 24;

export interface GhostTone {
  /** The runner's colour (`#RRGGBB`) for someone else's preview; null for the person's own, drawn in the theme's tokens. */
  color: string | null;
}

export interface GhostEnv {
  /** Screen pixels to board units at the current zoom. */
  px: (v: number) => number;
  /** The text and fill of a sticky already on the board (a group's ghost copies). */
  sticky: (id: string) => { text: string; fill: string } | undefined;
  bodyFont?: string;
  headingFont?: string;
}

const n = (v: number) => Math.round(v * 1000) / 1000;

const inflate = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by });

/** The box a preview takes on the board, outline and ghost title included: where its label row hangs. */
export function previewBox(layout: Layout): Rect {
  const box = inflate(layout.area, PREVIEW_PAD);
  if (layout.kind === 'create' && layout.frame) return { x: box.x, y: box.y - TITLE_BAND, w: box.w, h: box.h + TITLE_BAND };
  return box;
}

interface Paint { color: string; opacity: number }
interface Paints { area: Paint; wash: Paint; edge: Paint; rule: Paint; arrow: Paint }

function paints(tone: GhostTone): Paints {
  const c = tone.color ? escapeXml(tone.color) : null;
  const mixed = c ? `color-mix(in srgb, ${c} 80%, ${CANVAS_INK})` : CANVAS_INK;
  return {
    area: c ? { color: c, opacity: 1 } : { color: CANVAS_INK, opacity: 0.55 },
    wash: c ? { color: c, opacity: 0.08 } : { color: 'var(--signal, #FFD23F)', opacity: 0.08 },
    edge: c ? { color: mixed, opacity: 1 } : { color: CANVAS_INK, opacity: 0.55 },
    rule: { color: mixed, opacity: 1 },
    arrow: c ? { color: c, opacity: 0.45 } : { color: CANVAS_INK, opacity: 0.32 },
  };
}

const synth = (type: BaseObj['type'], r: Rect, extra: Partial<BaseObj> = {}): BaseObj => ({ id: 'ghost', type, x: 0, y: 0, w: r.w, h: r.h, rotation: 0, z: '', ...extra });

const textCache = new Map<string, string>();
const TEXT_CACHE_MAX = 600;

/** The text of a ghost sticky, laid out like a real one. Cached: it does not depend on the zoom. */
function stickyText(text: string, fill: string, r: Rect, font: string | undefined): string {
  const key = `${font ?? ''}|${fill}|${r.w}|${r.h}|${text}`;
  const hit = textCache.get(key);
  if (hit !== undefined) return hit;
  const o = synth('sticky', r, { fill, ...(font ? { font } : {}) });
  const out = textBlock(text, labelBox(o), styleOf(o), { shrink: true, valign: styleOf(o).valign });
  if (textCache.size >= TEXT_CACHE_MAX) textCache.clear();
  textCache.set(key, out);
  return out;
}

/** A sticky on the board as its ghost copy shows it. Writing hidden from this viewer (not yet revealed) is never copied out. */
export function ghostSource(o: { text?: string; fill?: string }, hidden: boolean, fallbackFill: string): { text: string; fill: string } {
  return { text: hidden ? '' : o.text ?? '', fill: o.fill ?? fallbackFill };
}

/** Forget the laid-out text (the fonts finished loading, so the measurements changed). */
export const clearGhostText = (): void => textCache.clear();

function dashed(p: Paint, width: number, dash: [number, number]): string {
  return `stroke="${p.color}" stroke-opacity="${p.opacity}" stroke-width="${n(width)}" stroke-dasharray="${n(dash[0])} ${n(dash[1])}"`;
}

function areaMarkup(area: Rect, p: Paints, px: GhostEnv['px']): string {
  const r = inflate(area, PREVIEW_PAD);
  return `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" fill="${p.wash.color}" fill-opacity="${p.wash.opacity}" ${dashed(p.area, px(2), [px(6), px(4)])}/>`;
}

function stickyGhost(r: Rect, text: string, fill: string, p: Paints, env: GhostEnv): string {
  const e = env.px(1.5);
  return `<g transform="translate(${n(r.x)} ${n(r.y)})"><rect width="${n(r.w)}" height="${n(r.h)}" fill="${escapeXml(fill)}"/>${stickyText(text, fill, r, env.bodyFont)}` +
    `<rect x="${n(e / 2)}" y="${n(e / 2)}" width="${n(r.w - e)}" height="${n(r.h - e)}" fill="none" ${dashed(p.edge, e, [env.px(4), env.px(3)])}/></g>`;
}

function frameTitle(frame: Rect & { title: string }, env: GhostEnv): string {
  const s = styleOf(synth('frame', frame, { font: env.headingFont }));
  return `<text x="${n(frame.x + 2)}" y="${n(frame.y - 10)}" font-family="${escapeXml(fontFamily(s.font))}" font-size="${s.fontSize}" font-weight="${s.fontWeight}" fill="${CANVAS_INK}">${escapeXml(frame.title)}</text>`;
}

function createMarkup(l: CreateLayout, p: Paints, env: GhostEnv): string {
  let out = areaMarkup(l.area, p, env.px);
  if (l.frame) out += frameTitle(l.frame, env);
  for (const s of l.stickies) out += stickyGhost(s, s.text, s.fill, p, env);
  return out;
}

/** A faint arrow from a sticky's right edge to its group's header, with a chevron for a head. */
function arrowMarkup(from: Rect, header: Rect, p: Paints, px: GhostEnv['px']): string {
  const s = { x: from.x + from.w, y: from.y + from.h / 2 };
  const e = { x: header.x - px(4), y: header.y + header.h / 2 };
  const dx = Math.max(px(40), Math.min(Math.abs(e.x - s.x) / 2, px(160)));
  const a = px(6);
  const d = `M${n(s.x)} ${n(s.y)}C${n(s.x + dx)} ${n(s.y)} ${n(e.x - dx)} ${n(e.y)} ${n(e.x)} ${n(e.y)}`;
  const head = `M${n(e.x - a)} ${n(e.y - a * 0.6)}L${n(e.x)} ${n(e.y)}L${n(e.x - a)} ${n(e.y + a * 0.6)}`;
  return `<path d="${d}${head}" fill="none" stroke="${p.arrow.color}" stroke-opacity="${p.arrow.opacity}" stroke-width="${n(px(1.25))}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function headerMarkup(header: Rect & { title: string }, p: Paints, env: GhostEnv): string {
  const o = synth('text', header, { fontWeight: 700, ...(env.bodyFont ? { font: env.bodyFont } : {}) });
  const rule = `<path d="M${n(header.x)} ${n(header.y + header.h)}H${n(header.x + header.w)}" fill="none" ${dashed(p.rule, env.px(2), [env.px(6), env.px(4)])}/>`;
  return `<g transform="translate(${n(header.x)} ${n(header.y)})">${textBlock(header.title, { x: 0, y: 0, w: header.w, h: header.h }, styleOf(o), { valign: 'top' })}</g>${rule}`;
}

function groupMarkup(l: GroupLayout, p: Paints, env: GhostEnv): string {
  let out = areaMarkup(l.area, p, env.px);
  // arrows first, so the ghost stickies lie over them
  for (const m of l.moves) {
    const header = l.headers.find((hd) => hd.x === m.to.x);
    if (header) out += arrowMarkup(m.from, header, p, env.px);
  }
  for (const hd of l.headers) out += headerMarkup(hd, p, env);
  for (const m of l.moves) {
    const s = env.sticky(m.id);
    if (s) out += stickyGhost(m.to, s.text, s.fill, p, env);
  }
  return out;
}

/**
 * One preview as SVG markup in board units: ghost stickies in their true colour with a dashed edge, a dashed outline over a
 * faint wash, a ghost frame title or ghost column headers with arrows. Drawn as decoration: no pointer events, hidden from
 * assistive technology (the bar and the label rows say what it is).
 */
export function ghostMarkup(layout: Layout, tone: GhostTone, env: GhostEnv): string {
  const p = paints(tone);
  const body = layout.kind === 'create' ? createMarkup(layout, p, env) : groupMarkup(layout, p, env);
  return `<g pointer-events="none" aria-hidden="true">${body}</g>`;
}

// ---------------------------------------------------------------- label rows

export const ROW_H = 24;
const ROW_GAP = 2;
const ROW_MARGIN = 4;
const ROW_EDGE = 8;
const ROW_STEP = 24;
const ROW_STEPS = 24;

export interface LabelRowIn { id: string; /** the preview's box in screen pixels */ anchor: Rect; w: number; h: number }
export interface LabelRowOut { x: number; y: number; below: boolean }

const touches = (a: Rect, b: Rect, padX = 4, padY = 2): boolean => a.x < b.x + b.w + padX && b.x < a.x + a.w + padX && a.y < b.y + b.h + padY && b.y < a.y + a.h + padY;

/**
 * Where each label row goes, in stacking order. A row hangs above its preview's top-left corner, kept inside the board. If it
 * would touch a row already placed or an obstacle (the selection quick bar, the AI bar) it moves under the bottom-left corner,
 * and if that collides too it steps down 24px at a time. Previews themselves never move.
 */
export function placeLabelRows(rows: readonly LabelRowIn[], obstacles: readonly Rect[], board: { w: number; h: number }): Map<string, LabelRowOut> {
  const out = new Map<string, LabelRowOut>();
  const placed: Rect[] = [];
  for (const row of rows) {
    const x = Math.max(ROW_EDGE, Math.min(board.w - row.w - ROW_EDGE, row.anchor.x - 2));
    const clampY = (y: number) => Math.max(ROW_MARGIN, Math.min(board.h - row.h - ROW_MARGIN, y));
    const box = (y: number): Rect => ({ x, y, w: row.w, h: row.h });
    const free = (y: number) => ![...placed, ...obstacles].some((o) => touches(box(y), o));
    let y = clampY(row.anchor.y - row.h - ROW_GAP);
    let below = false;
    if (!free(y)) {
      below = true;
      y = clampY(row.anchor.y + row.anchor.h + ROW_GAP);
      for (let i = 0; i < ROW_STEPS && !free(y); i++) y = clampY(y + ROW_STEP);
    }
    out.set(row.id, { x, y, below });
    placed.push(box(y));
  }
  return out;
}

export const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// ---------------------------------------------------------------- target outline

/** The bounds of what a run was started on: its selection (the objects still on the board) or its frame; null when there is none. */
export function targetBounds(target: RunTarget, bounds: (id: string) => Rect | null): Rect | null {
  if (!target) return null;
  if ('frameId' in target) return bounds(target.frameId);
  const found = target.ids.map(bounds).filter((r): r is Rect => r !== null);
  if (!found.length) return null;
  const x0 = Math.min(...found.map((r) => r.x)), y0 = Math.min(...found.map((r) => r.y));
  const x1 = Math.max(...found.map((r) => r.x + r.w)), y1 = Math.max(...found.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---------------------------------------------------------------- words

/** The label on a preview: "Your AI preview", "Ana's AI preview", or "AI preview" when nobody is named (open mode). */
export function previewLabelText(run: Pick<LiveRun, 'by'>, mine: boolean): string {
  if (mine) return 'Your AI preview';
  const name = run.by.name?.trim();
  return name ? `${name}'s AI preview` : 'AI preview';
}

const nameOf = (p: { name: string | null } | null | undefined): string | null => p?.name?.trim() || null;

const groupedStickies = (p: Extract<AiProposal, { kind: 'group' }>): number => p.groups.reduce((sum, g) => sum + g.ids.length, 0);

/** The toast after accepting someone's preview: "Added Ana's 4 stickies." (without a name: "Added 4 stickies."). */
export function acceptedMessage(proposal: AiProposal, owner: string | null): string {
  const whose = owner ? `${owner}'s ` : '';
  if (proposal.kind === 'group') return `Moved ${whose}${plural(groupedStickies(proposal), 'sticky', 'stickies')} into ${plural(proposal.groups.length, 'group', 'groups')}.`;
  return `Added ${whose}${plural(proposal.objects.length, 'sticky', 'stickies')}.`;
}

/** The toast after discarding someone's preview. */
export const discardedMessage = (owner: string | null): string => `Discarded ${owner ? `${owner}'s` : 'the'} preview.`;

/** The possessive for a runner who settled their own preview: neutral, since a name says nothing about pronouns. */
export const THEIR_OWN = 'their';

/**
 * The toast when a click on someone's preview lost the race: who settled it, and how (docs/ai.md, 409 `ai_run_resolved`).
 * `owner` is the runner, `me` this person's account id.
 */
export function firstMessage(
  action: string | null,
  by: { id: string | null; name: string | null } | null,
  owner: { id: string | null; name: string | null } | null,
  me: string | null = null,
): string {
  const ownerName = nameOf(owner);
  const whose = ownerName ? `${ownerName}'s` : 'the';
  const Whose = ownerName ? `${ownerName}'s` : 'The';
  const who = nameOf(by) ?? 'Someone';
  if (action === 'expired') return `${Whose} preview expired.`;
  if (action === 'failed') return 'That AI run did not finish.';
  if (action !== 'accept' && action !== 'discard') return `${Whose} preview was already settled.`;
  const verb = action === 'accept' ? 'added' : 'discarded';
  if (by?.id && me && by.id === me) return `${Whose} preview was already ${verb}.`;
  const runner = !!by && !!owner && ((by.id !== null && by.id === owner.id) || (by.id === null && owner.id === null && !!nameOf(by) && nameOf(by) === ownerName));
  const tail = action === 'discard' ? ' Nothing was added.' : '';
  return `${who} ${verb} ${runner ? THEIR_OWN : whose} preview first.${tail}`;
}

/** The toast on the runner's own bar when someone else settled their preview ("Ben added your preview."). */
export function settledNotice(run: Pick<SettledRun, 'status' | 'resolvedBy'>, me: string | null): string {
  const action = run.status === 'accepted' ? 'accept' : run.status === 'discarded' ? 'discard' : run.status;
  return settledMessage(action, run.resolvedBy, me);
}

// ---------------------------------------------------------------- people

/**
 * Whether a person in the room is the runner of a run. The relay names the account (`by.id`); the room names a device
 * (`user.id`), so when the ids differ the name and the colour the runner sent decide.
 */
export function isRunner(user: { id: string; name: string; color: string }, by: RunPerson): boolean {
  if (by.id !== null && user.id === by.id) return true;
  return !!by.name && user.name === by.name && sameColor(user.color, by.color);
}

/** The run that earns this person's avatar the spark badge: a run in flight before a preview. */
export function badgeRun(user: { id: string; name: string; color: string }, runs: readonly LiveRun[]): LiveRun | null {
  const theirs = runs.filter((r) => isRunner(user, r.by));
  return theirs.find((r) => r.status === 'running') ?? theirs.find((r) => r.status === 'ready') ?? null;
}

/** The tooltip and accessible name of a runner's avatar: "Ana is asking AI: Summarise…" / "Ana has an AI preview on this board". */
export function avatarLine(run: Pick<LiveRun, 'by' | 'feature' | 'status'>): string {
  return run.status === 'running' ? presenceLine(run) : `${nameOf(run.by) ?? 'Someone'} has an AI preview on this board`;
}

/** Whether a preview gets the Discard and Accept tray: editors only, and not for the run the bar itself acts on. */
export const hasTray = (run: Pick<LiveRun, 'id'>, o: { readOnly: boolean; barRunId: string | null }): boolean => !o.readOnly && run.id !== o.barRunId;
