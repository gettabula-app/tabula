import type { AiConfig, AiFeature } from './api';
import type { AiProposal } from './ai-apply';
import { PROVIDER_LABEL } from './ui/ai-logic';

// The pure rules and text of the AI bar (docs/ai-toolbar.md, docs/ai.md): no DOM, so they can be unit tested. src/ui/ai-bar.ts
// reads the board, draws the bar and calls the relay; everything it can decide without either lives here.

// ---------------------------------------------------------------- context

export type AiContext = 'selection' | 'view' | 'board' | 'none';

/** What the board holds, as the bar counts it. Only stickies are read by the v1 features. */
export interface Facts {
  /** Objects the selection stands for: its non-frame objects, and the stickies inside a selected frame. */
  selected: number;
  selectedStickies: number;
  /** Stickies in the viewport. */
  inView: number;
  /** Stickies on the board. */
  onBoard: number;
}

export const NO_FACTS: Facts = { selected: 0, selectedStickies: 0, inView: 0, onBoard: 0 };

/** The relay reads at most this many objects of a run (docs/ai.md, "Limits"); the bar sends no more ids than it takes. */
export const SEND_MAX = 400;
export const CLUSTER_MIN = 2;
export const CLUSTER_MAX = 200;
export const PROMPT_MAX = 2000;
export const NAME_MAX = 40;

export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Selecting something switches to the selection; clearing it switches a selection context to the visible area. Other choices stay. */
export function contextAfterSelection(current: AiContext, selected: number): AiContext {
  if (selected > 0) return 'selection';
  return current === 'selection' ? 'view' : current;
}

/** The objects a selection holds, named for the pill: stickies when all of them are, else items. */
function selectionNoun(facts: Facts, n: number): string {
  return facts.selected === facts.selectedStickies ? (n === 1 ? 'sticky' : 'stickies') : n === 1 ? 'item' : 'items';
}

export function contextLabel(ctx: AiContext, facts: Facts): string {
  if (ctx === 'selection') return `${facts.selected} ${selectionNoun(facts, facts.selected)}`;
  if (ctx === 'view') return 'Visible area';
  if (ctx === 'board') return 'Whole board';
  return 'Prompt only';
}

/** Stickies the run reads in this context: what the chips and the estimate go by. */
export function contextStickies(ctx: AiContext, facts: Facts): number {
  if (ctx === 'selection') return facts.selectedStickies;
  if (ctx === 'view') return facts.inView;
  if (ctx === 'board') return facts.onBoard;
  return 0;
}

export interface ContextItem {
  id: AiContext;
  label: string;
  hint: string;
  disabled: boolean;
}

export function contextMenu(facts: Facts): ContextItem[] {
  const some = facts.selected > 0;
  return [
    {
      id: 'selection',
      label: some ? `${facts.selected} selected ${selectionNoun(facts, facts.selected)}` : 'Selection',
      hint: some ? '' : 'Nothing selected',
      disabled: !some,
    },
    { id: 'view', label: 'Visible area', hint: plural(facts.inView, 'sticky', 'stickies'), disabled: false },
    { id: 'board', label: 'Whole board', hint: plural(facts.onBoard, 'sticky', 'stickies'), disabled: false },
    { id: 'none', label: 'Prompt only', hint: 'No board content', disabled: false },
  ];
}

// ---------------------------------------------------------------- chips and arming

export const FEATURE_LABEL: Record<AiFeature, string> = { summarise: 'Summarise', cluster: 'Cluster', generate: 'Generate ideas' };
/** What Run says it starts. */
export const RUN_LABEL: Record<AiFeature, string> = { summarise: 'Summarise', cluster: 'Cluster', generate: 'Generate sticky notes' };

/** The chip row, in order. A feature adds a chip by adding an entry here. */
export const CHIPS: { id: AiFeature; label: string }[] = [
  { id: 'summarise', label: FEATURE_LABEL.summarise },
  { id: 'cluster', label: FEATURE_LABEL.cluster },
  { id: 'generate', label: FEATURE_LABEL.generate },
];

export const TURNED_OFF = 'Turned off for this workspace';
export const RUN_NEEDS_PROMPT = 'Type what to generate, or pick an action above';

export interface ChipState {
  enabled: boolean;
  /** The tooltip of a disabled chip. */
  reason: string | null;
}

export function chipState(feature: AiFeature, ctx: AiContext, facts: Facts, allowed: readonly AiFeature[]): ChipState {
  const no = (reason: string): ChipState => ({ enabled: false, reason });
  if (!allowed.includes(feature)) return no(TURNED_OFF);
  const stickies = contextStickies(ctx, facts);
  if (feature === 'summarise') {
    if (ctx === 'none') return no('Choose what to summarise: a selection, the visible area or the whole board');
    if (stickies < 2) {
      if (ctx === 'selection') return no('Select 2 or more stickies to summarise');
      return no(ctx === 'view' ? 'There are fewer than 2 stickies in view to summarise' : 'The board has fewer than 2 stickies to summarise');
    }
  }
  if (feature === 'cluster') {
    if (ctx !== 'selection' || stickies < CLUSTER_MIN) return no('Select 2 or more stickies to cluster');
    if (stickies > CLUSTER_MAX) return no('Select 200 stickies or fewer to cluster');
  }
  return { enabled: true, reason: null };
}

/** One chip is armed at a time. It disarms when its action stops being available (a Cluster selection drops to one sticky). */
export function armedAfter(armed: AiFeature | null, ctx: AiContext, facts: Facts, allowed: readonly AiFeature[]): AiFeature | null {
  return armed && chipState(armed, ctx, facts, allowed).enabled ? armed : null;
}

/** A click on a chip: arms it, or disarms it when it is the armed one. A disabled chip does nothing. */
export function toggleArmed(armed: AiFeature | null, id: AiFeature, ctx: AiContext, facts: Facts, allowed: readonly AiFeature[]): AiFeature | null {
  if (!chipState(id, ctx, facts, allowed).enabled) return armed;
  return armed === id ? null : id;
}

/** What Run or Enter starts: the armed action, else Generate when a prompt is typed. Null when nothing would run. */
export function runTarget(armed: AiFeature | null, prompt: string, ctx: AiContext, facts: Facts, allowed: readonly AiFeature[]): AiFeature | null {
  const feature = armed && armed !== 'generate' ? armed : prompt.trim() ? 'generate' : null;
  return feature && chipState(feature, ctx, facts, allowed).enabled ? feature : null;
}

/** The tooltip of Run: the action it starts, or why it cannot start one. */
export function runTip(target: AiFeature | null): string {
  return target ? RUN_LABEL[target] : RUN_NEEDS_PROMPT;
}

export const PLACEHOLDER = 'Generate sticky notes about…';
export const PLACEHOLDER_OPTIONAL = 'Optional instruction…';
export const PLACEHOLDER_CLUSTER = 'Groups the selected stickies by theme';

export function placeholderFor(armed: AiFeature | null): string {
  if (armed === 'summarise') return PLACEHOLDER_OPTIONAL;
  if (armed === 'cluster') return PLACEHOLDER_CLUSTER;
  return PLACEHOLDER;
}

/** Whether the typed prompt is part of the request. The relay takes none for a cluster (docs/ai.md, "Slice B"). */
export const promptSent = (feature: AiFeature | null): boolean => feature !== 'cluster';

/** The words of a running bar: "Summarising 42 stickies…". */
export function runningText(feature: AiFeature, ctx: AiContext, facts: Facts): string {
  if (feature === 'generate') return 'Generating ideas…';
  const verb = feature === 'summarise' ? 'Summarising' : 'Clustering';
  const n = ctx === 'selection' ? facts.selected : ctx === 'view' ? facts.inView : ctx === 'board' ? facts.onBoard : 0;
  if (n < 1) return `${verb}…`;
  const noun = ctx === 'selection' ? selectionNoun(facts, n) : n === 1 ? 'sticky' : 'stickies';
  return `${verb} ${n} ${noun}…`;
}

// ---------------------------------------------------------------- cost and model

const SHORT_MODELS: Record<string, string> = { 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5' };
/** Known Anthropic ids get product names; namespaced provider ids use their final part. */
export const modelShort = (id: string): string => {
  const known = SHORT_MODELS[id];
  if (known) return known;
  const slash = id.lastIndexOf('/');
  return slash >= 0 && slash < id.length - 1 ? id.slice(slash + 1) : id;
};

/** The reply cap per feature (server/ai/features.mjs). */
export const OUTPUT_CAP: Record<AiFeature, number> = { generate: 4000, summarise: 8000, cluster: 8000 };

/** Input tokens of a run, guessed in the browser: about 1,000 for the system prompt, 100 per sticky, a quarter of the prompt's characters. */
export function estimateTokens(stickies: number, promptChars: number): number {
  return Math.round(1000 + 100 * Math.min(stickies, SEND_MAX) + promptChars / 4);
}

/** "~1.3k" (and "~950" under a thousand): the number carries a "~" because it is a guess. */
export function formatTokens(n: number): string {
  if (n < 1000) return `~${Math.max(50, Math.round(n / 50) * 50)}`;
  return `~${String(Math.round(n / 100) / 10)}k`;
}

const thousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** "1,300", rounded to 50, for the popover. */
export const formatExact = (n: number): string => thousands(Math.round(n / 50) * 50);

export interface ChipFacts {
  armed: AiFeature | null;
  model: string;
  ctx: AiContext;
  facts: Facts;
  prompt: string;
}

/** The estimate for exactly what Run would send: the prompt counts unless the armed action takes none. */
export function estimateFor(o: Pick<ChipFacts, 'armed' | 'ctx' | 'facts' | 'prompt'>): number {
  return estimateTokens(contextStickies(o.ctx, o.facts), promptSent(o.armed) ? o.prompt.trim().length : 0);
}

/** "Opus 5.5 · ~1.3k tokens", or with an action armed "Summarise · ~1.3k tokens". */
export function modelChipText(o: ChipFacts): string {
  const cost = `${formatTokens(estimateFor(o))} tokens`;
  return `${o.armed ? FEATURE_LABEL[o.armed] : modelShort(o.model)} · ${cost}`;
}

export const modelChipLabel = (text: string): string => `${text}. Model and token estimate details`;
export const MODEL_CHIP_TIP = 'Estimate before you run. Click for details.';

export const CHOSEN_BY_ADMIN = 'Chosen by your workspace admin.';
export const VISIBILITY_OFF = 'Others on this board see that you are asking AI, and see your preview.';
export const VISIBILITY_ON = 'Nobody else on this board sees the run or the preview until you add it.';
export const NOT_PRIVATE = "Runs on the workspace key can't be private: the workspace pays for them.";

export function thisRunText(tokens: number, cap: number): string {
  return `About ${formatExact(tokens)} tokens go in; the reply is capped at ${thousands(cap)}. An estimate, not a bill.`;
}

// ---------------------------------------------------------------- the disclosure line

/** A private run is for a personal key only; on the workspace key the switch does not exist and the relay refuses it. */
export const effectivePrivate = (on: boolean, keySource: AiConfig['keySource']): boolean => on && keySource === 'user';

export function keyText(keySource: AiConfig['keySource'], privateRun: boolean): string {
  if (keySource === 'user') return privateRun ? 'Uses your key · Private run' : 'Uses your key';
  if (keySource === 'workspace') return 'Uses the workspace key';
  return 'No AI key set';
}

/** "Sends 3 selected stickies and your prompt to Anthropic". When the relay will cut the content, the count is the capped one. */
export function sendsText(ctx: AiContext, facts: Facts, prompt: string, withPrompt = true): string {
  const typed = withPrompt && prompt.trim().length > 0;
  const stickies = ctx === 'selection' ? facts.selected : ctx === 'view' ? facts.inView : ctx === 'board' ? facts.onBoard : 0;
  const bare = ctx === 'none' || stickies < 1;
  let what: string;
  if (bare) what = typed ? 'only your prompt' : 'only what you type';
  else {
    if (ctx === 'selection') {
      const noun = selectionNoun(facts, stickies);
      what = stickies > SEND_MAX ? `${SEND_MAX} of the ${stickies} selected ${noun}` : `${stickies} selected ${noun}`;
    } else if (ctx === 'view') {
      what = stickies > SEND_MAX ? `the ${SEND_MAX} stickies nearest the middle of the view` : `the ${plural(stickies, 'sticky', 'stickies')} in view`;
    } else {
      what = stickies > SEND_MAX ? `the ${SEND_MAX} stickies nearest the middle of the board` : stickies === 1 ? 'the 1 sticky on the board' : `all ${stickies} stickies`;
    }
    if (typed) what += ' and your prompt';
  }
  return `Sends ${what} to ${PROVIDER_LABEL}`;
}

export type BarUi = 'idle' | 'running' | 'preview' | 'error';

export const PREVIEW_NOTE = 'Nothing is on the board until you add it';
export const previewKeys = (kind: AiProposal['kind']): string => (kind === 'group' ? 'Enter moves them, Esc discards' : 'Enter adds, Esc discards');

export interface DisclosureInput {
  ui: BarUi;
  ctx: AiContext;
  facts: Facts;
  prompt: string;
  /** Whether the typed prompt goes with the request (not for a cluster). */
  withPrompt: boolean;
  keySource: AiConfig['keySource'];
  privateRun: boolean;
  proposalKind: AiProposal['kind'] | null;
}

/** The two segments of row 3: what is sent and who pays; while running "Esc stops"; in a preview what adding does. */
export function disclosure(o: DisclosureInput): [string, string] {
  const priv = effectivePrivate(o.privateRun, o.keySource);
  if (o.ui === 'preview') return [PREVIEW_NOTE, previewKeys(o.proposalKind ?? 'create')];
  const sends = sendsText(o.ctx, o.facts, o.prompt, o.withPrompt);
  if (o.ui === 'running') return [sends, priv ? 'Private run · Esc stops' : 'Esc stops'];
  return [sends, keyText(o.keySource, priv)];
}

// ---------------------------------------------------------------- the request

export type RunBody = {
  feature: AiFeature;
  boardId: string;
  input: Record<string, unknown>;
  private?: true;
  presence?: { color?: string; name?: string; outline?: false };
};

export interface BodyInput {
  feature: AiFeature;
  boardId: string;
  ctx: AiContext;
  prompt: string;
  /** All selected object ids (a selected frame stands for its stickies), and the sticky ones among them. */
  selection: readonly string[];
  selectionStickies: readonly string[];
  /** Stickies in view, nearest the middle first. */
  view: readonly string[];
  person: { name?: string | null; color?: string | null };
  keySource: AiConfig['keySource'];
  privateRun: boolean;
}

const COLOR_RE = /^#[0-9a-f]{6}$/i;

/** The ids a run names, by context. Whole board and prompt only name none. A cluster takes stickies only. */
export function contextIds(o: Pick<BodyInput, 'feature' | 'ctx' | 'selection' | 'selectionStickies' | 'view'>): string[] {
  if (o.ctx === 'selection') return (o.feature === 'cluster' ? o.selectionStickies.slice(0, CLUSTER_MAX) : o.selection.slice(0, SEND_MAX)).map(String);
  if (o.ctx === 'view') return o.view.slice(0, SEND_MAX).map(String);
  return [];
}

/** The body of POST /api/ai/run. It carries only the fields the feature takes: the relay refuses unknown ones (server/ai/features.mjs). */
export function buildRunBody(o: BodyInput): RunBody {
  const ids = contextIds(o);
  const prompt = o.prompt.trim().slice(0, PROMPT_MAX).trim();
  const input: Record<string, unknown> = {};
  if (o.feature === 'generate') input.prompt = prompt;
  if (o.feature === 'summarise' && prompt) input.prompt = prompt;
  if (ids.length) input.selection = ids;

  const presence: NonNullable<RunBody['presence']> = {};
  if (o.person.color && COLOR_RE.test(o.person.color)) presence.color = o.person.color;
  const name = [...(o.person.name ?? '').replace(/\s+/g, ' ').trim()].slice(0, NAME_MAX).join('');
  if (name) presence.name = name;
  if (o.ctx === 'view') presence.outline = false;

  const body: RunBody = { feature: o.feature, boardId: o.boardId, input };
  if (effectivePrivate(o.privateRun, o.keySource)) body.private = true;
  if (Object.keys(presence).length) body.presence = presence;
  return body;
}

/** The `max` ids nearest `center`, nearest first (ties by id), for a visible area that holds more than the relay reads. */
export function nearestIds(items: readonly { id: string; x: number; y: number }[], center: { x: number; y: number }, max = SEND_MAX): string[] {
  return items
    .map((i) => ({ id: i.id, d: Math.hypot(i.x - center.x, i.y - center.y) }))
    .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, max)
    .map((i) => i.id);
}

// ---------------------------------------------------------------- the stream

export interface SseMessage {
  event: string;
  data: string;
}

/**
 * A server-sent events parser. Feed it text in chunks cut anywhere; it calls `onMessage` for each complete event (a
 * blank line ends one). Handles \n, \r\n and \r line ends, comments, multi-line data and several events per chunk.
 */
export function createSseParser(onMessage: (m: SseMessage) => void): { push(chunk: string): void; end(): void } {
  let buf = '';
  let event = '';
  let data: string[] = [];

  const line = (text: string) => {
    if (text === '') {
      if (data.length) onMessage({ event: event || 'message', data: data.join('\n') });
      event = '';
      data = [];
      return;
    }
    if (text.startsWith(':')) return;
    const at = text.indexOf(':');
    const field = at < 0 ? text : text.slice(0, at);
    let value = at < 0 ? '' : text.slice(at + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };

  return {
    push(chunk) {
      buf += chunk;
      let pos = 0;
      for (;;) {
        let end = pos;
        while (end < buf.length && buf[end] !== '\n' && buf[end] !== '\r') end++;
        if (end >= buf.length) break;
        // a \r at the very end may be the first half of \r\n: wait for the next chunk
        if (buf[end] === '\r' && end + 1 >= buf.length) break;
        line(buf.slice(pos, end));
        pos = end + (buf[end] === '\r' && buf[end + 1] === '\n' ? 2 : 1);
      }
      buf = buf.slice(pos);
    },
    end() {
      if (buf) line(buf.replace(/\r$/, ''));
      buf = '';
      line('');
    },
  };
}

export type AiStreamEvent =
  | { type: 'progress'; n: number; runId: string | null }
  | { type: 'result'; runId: string | null; proposal: AiProposal; cut: boolean }
  | { type: 'error'; code: string; message: string | null };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether a value has the shape of a proposal. The relay has validated it; this keeps a malformed answer from crashing the bar. */
export function isProposal(v: unknown): v is AiProposal {
  if (!isRecord(v)) return false;
  if (v.kind === 'create') return Array.isArray(v.objects) && v.objects.length > 0 && v.objects.every((o) => isRecord(o) && typeof o.text === 'string');
  if (v.kind === 'group') return Array.isArray(v.groups) && v.groups.length > 0 && v.groups.every((g) => isRecord(g) && typeof g.title === 'string' && Array.isArray(g.ids));
  return false;
}

/** The event a message stands for, or null for one the bar does not know or cannot read. */
export function parseAiEvent(m: SseMessage): AiStreamEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(m.data);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const runId = typeof data.runId === 'string' ? data.runId : null;
  if (m.event === 'progress') return { type: 'progress', n: typeof data.n === 'number' ? data.n : 0, runId };
  if (m.event === 'result') return isProposal(data.proposal) ? { type: 'result', runId, proposal: data.proposal, cut: data.cut === true } : null;
  if (m.event === 'error') return { type: 'error', code: typeof data.error === 'string' ? data.error : 'internal', message: typeof data.message === 'string' ? data.message : null };
  return null;
}

export interface AiFailure {
  /** A server code, or 'network' (the connection failed), 'aborted' (Stop) or 'unknown'. */
  code: string;
  status: number;
  message: string | null;
  /** Seconds, from the retry-after header. */
  retryAfter: number | null;
}

export type AiOutcome = { ok: true; runId: string | null; proposal: AiProposal; cut: boolean } | { ok: false; failure: AiFailure };

const failed = (code: string, status = 0, message: string | null = null, retryAfter: number | null = null): AiOutcome => ({ ok: false, failure: { code, status, message, retryAfter } });

/** A plain-HTTP error's code from its status, for an answer without a body. */
function codeOfStatus(status: number): string {
  if (status === 429) return 'rate_limited';
  if (status === 402) return 'read_only';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  return status >= 500 ? 'internal' : 'unknown';
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const data: unknown = JSON.parse(await res.text());
    return isRecord(data) ? data : {};
  } catch {
    return {};
  }
}

const POST_HEADERS = { 'content-type': 'application/json', 'x-tabula': '1' };

/**
 * POST /api/ai/run and read its stream. Resolves with the proposal or a failure; never throws. `onRunId` is called with the id
 * the first `progress` event names. Aborting `signal` (Stop) ends it with the failure code 'aborted'.
 */
export async function runAi(fetchFn: typeof fetch, body: RunBody, opts: { signal?: AbortSignal; onRunId?: (id: string) => void } = {}): Promise<AiOutcome> {
  const { signal, onRunId } = opts;
  let res: Response;
  try {
    res = await fetchFn('/api/ai/run', { method: 'POST', credentials: 'same-origin', signal, headers: { ...POST_HEADERS, accept: 'text/event-stream' }, body: JSON.stringify(body) });
  } catch {
    return failed(signal?.aborted ? 'aborted' : 'network');
  }
  if (!res.ok) {
    const data = await readJson(res);
    const wait = Math.ceil(Number(res.headers.get('retry-after')));
    return failed(
      typeof data.error === 'string' ? data.error : codeOfStatus(res.status),
      res.status,
      typeof data.message === 'string' ? data.message : null,
      Number.isFinite(wait) && wait > 0 ? wait : null,
    );
  }

  const seen: { runId: string | null; outcome: AiOutcome | null } = { runId: null, outcome: null };
  const parser = createSseParser((m) => {
    if (seen.outcome) return;
    const ev = parseAiEvent(m);
    if (!ev) return;
    if (ev.type === 'progress') {
      if (ev.runId && !seen.runId) {
        seen.runId = ev.runId;
        onRunId?.(ev.runId);
      }
    } else if (ev.type === 'result') seen.outcome = { ok: true, runId: ev.runId ?? seen.runId, proposal: ev.proposal, cut: ev.cut };
    else seen.outcome = failed(ev.code, 200, ev.message);
  });
  try {
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
        if (seen.outcome) {
          void reader.cancel().catch(() => undefined);
          break;
        }
      }
      parser.push(decoder.decode());
    } else parser.push(await res.text());
    parser.end();
  } catch {
    return seen.outcome ?? failed(signal?.aborted ? 'aborted' : 'network');
  }
  return seen.outcome ?? failed(signal?.aborted ? 'aborted' : 'internal');
}

export type ResolveAction = 'accept' | 'discard';

export type ResolveOutcome =
  | { kind: 'ok'; action: ResolveAction; proposal: AiProposal | null }
  /** Someone else got there first, or the run failed or expired: `action` says how, `by` who. */
  | { kind: 'settled'; action: string | null; by: { id: string | null; name: string | null } | null }
  | { kind: 'running' }
  | { kind: 'gone' }
  | { kind: 'forbidden' }
  | { kind: 'read_only' }
  | { kind: 'network' }
  | { kind: 'error' };

function parseBy(v: unknown): { id: string | null; name: string | null } | null {
  if (!isRecord(v)) return null;
  return { id: typeof v.id === 'string' ? v.id : null, name: typeof v.name === 'string' && v.name.trim() ? v.name.trim() : null };
}

/** POST /api/ai/runs/:id/resolve. Never throws. The first call wins; an accept answers with the proposal to write. */
/** `name` is the person's display name: open mode tells the runner who settled their run by it (accounts mode ignores it). */
export async function resolveAiRun(fetchFn: typeof fetch, runId: string, action: ResolveAction, signal?: AbortSignal, name?: string | null): Promise<ResolveOutcome> {
  let res: Response;
  const clean = [...(name ?? '').replace(/\s+/g, ' ').trim()].slice(0, NAME_MAX).join('').trim();
  try {
    res = await fetchFn(`/api/ai/runs/${encodeURIComponent(runId)}/resolve`, {
      method: 'POST', credentials: 'same-origin', signal, headers: { ...POST_HEADERS, accept: 'application/json' },
      body: JSON.stringify(clean ? { action, presence: { name: clean } } : { action }),
    });
  } catch {
    return { kind: 'network' };
  }
  const data = await readJson(res);
  if (res.ok) {
    if (action === 'accept' && !isProposal(data.proposal)) return { kind: 'error' };
    return { kind: 'ok', action, proposal: isProposal(data.proposal) ? data.proposal : null };
  }
  if (res.status === 409 && data.error === 'ai_run_running') return { kind: 'running' };
  if (res.status === 409) return { kind: 'settled', action: typeof data.action === 'string' ? data.action : null, by: parseBy(data.by) };
  if (res.status === 404) return { kind: 'gone' };
  if (res.status === 403) return { kind: 'forbidden' };
  if (res.status === 402) return { kind: 'read_only' };
  return { kind: 'error' };
}

// ---------------------------------------------------------------- errors

export type ErrorKind = 'nokey' | 'invalid' | 'rate' | 'down' | 'refused' | 'readonly' | 'offline' | 'request' | 'unusable' | 'changed' | 'denied' | 'signin' | 'generic';

export interface ErrorView {
  kind: ErrorKind;
  /** The sentence, without its link or note. */
  text: string;
  /** A link at the end of the sentence: `before`, the link, `after`. */
  link: { before: string; label: string; after: string; target: 'admin-ai' | 'my-key' } | null;
  /** Plain text after the sentence for people who have no link to follow. */
  note: string | null;
  retry: boolean;
  /** The refusal's way back to the prompt. */
  edit: boolean;
  /** Seconds the Retry button stays disabled. */
  wait: number | null;
  offline: boolean;
}

export const DEFAULT_WAIT = 30;
export const MAX_WAIT = 3600;
export const ASK_ADMIN = 'Ask a workspace admin.';

export const isAdminRole = (role: string | null | undefined): boolean => role === 'owner' || role === 'admin';

/** An admin can open workspace AI settings from a board only after the disabled config has loaded. */
export function showSetUpAi(o: { flag: boolean; config: Partial<Pick<AiConfig, 'enabled' | 'hasSecret'>> | null | undefined; role: string | null | undefined }): boolean {
  return o.flag && o.config?.enabled === false && isAdminRole(o.role);
}

/** "40 s", and "3 min" once a wait is longer than a minute and a half. */
export const formatWait = (s: number): string => (s <= 90 ? `${s} s` : `${Math.ceil(s / 60)} min`);
const waitWords = (s: number): string => (s <= 90 ? plural(s, 'second', 'seconds') : plural(Math.ceil(s / 60), 'minute', 'minutes'));

export const rateText = (s: number): string => (s > 0 ? `Too many requests. Try again in ${formatWait(s)}.` : 'Too many requests. You can try again now.');
/** What a screen reader gets: the sentence once, and again when the wait ends. */
export const rateSpoken = (s: number): string => (s > 0 ? `Too many requests. Try again in ${waitWords(s)}.` : 'You can try again now.');

export interface ErrorContext {
  admin: boolean;
  keySource: AiConfig['keySource'];
  retryAfter?: number | null;
  message?: string | null;
}

/** Seconds to wait from a retry-after header: 30 when it is missing, and no more than an hour. */
export const waitOf = (retryAfter: number | null | undefined): number => (retryAfter && retryAfter > 0 ? Math.min(MAX_WAIT, Math.ceil(retryAfter)) : DEFAULT_WAIT);

/** The row the bar shows for a failure (docs/ai-toolbar.md, "Errors"). It never carries a raw code, a key or a provider's own message. */
export function errorView(code: string, ctx: ErrorContext): ErrorView {
  const row = (kind: ErrorKind, text: string, extra: Partial<ErrorView> = {}): ErrorView => ({
    kind, text, link: null, note: null, retry: false, edit: false, wait: null, offline: false, ...extra,
  });
  switch (code) {
    case 'ai_disabled':
    case 'ai_feature_disabled':
    case 'ai_no_key':
    case 'ai_key_unreadable':
    case 'ai_unconfigured':
      return ctx.admin
        ? row('nokey', "AI isn't set up for this workspace.", { link: { before: '', label: 'Set up AI', after: '', target: 'admin-ai' } })
        : row('nokey', "AI isn't set up for this workspace.", { note: ASK_ADMIN });
    case 'ai_key_invalid': {
      const own = ctx.keySource === 'user';
      if (ctx.admin || own) return row('invalid', 'The AI key was rejected.', { link: { before: 'Check it in ', label: 'AI settings', after: '.', target: own ? 'my-key' : 'admin-ai' } });
      return row('invalid', 'The AI key was rejected.', { note: 'Ask a workspace admin to check it.' });
    }
    case 'ai_model_invalid': {
      const own = ctx.keySource === 'user';
      const text = 'The provider does not know this model or this address. Check the base URL and the model.';
      if (ctx.admin || own) return row('invalid', text, { link: { before: 'Check it in ', label: 'AI settings', after: '.', target: own ? 'my-key' : 'admin-ai' } });
      return row('invalid', text, { note: 'Ask a workspace admin to check it.' });
    }
    case 'ai_bad_output':
      return row('unusable', 'This model did not answer in the required JSON format. Try a stronger instruction-following model. Nothing was changed.', { retry: true });
    case 'rate_limited':
    case 'ai_rate_limited': {
      const wait = waitOf(ctx.retryAfter);
      return row('rate', rateText(wait), { retry: true, wait });
    }
    case 'ai_unavailable':
    case 'ai_timeout':
    case 'internal':
      return row('down', "Anthropic isn't responding. Try again in a moment.", { retry: true });
    case 'ai_refused':
      return row('refused', 'The AI declined this request. Nothing was changed.', { edit: true });
    case 'read_only':
      return row('readonly', "AI isn't available while this workspace is read-only.");
    case 'network':
    case 'offline':
      return row('offline', "You're offline. AI needs a connection.", { retry: true, offline: true });
    case 'bad_request':
      return row('request', ctx.message?.trim() || 'The request could not be used.');
    case 'ai_invalid_proposal':
      return row('unusable', "The AI's answer could not be used. Nothing was changed.", { retry: true });
    case 'board_changed':
      return row('changed', 'The board changed while you were looking. Run it again.', { retry: true });
    case 'forbidden':
    case 'not_found':
      return row('denied', "AI isn't available on this board.");
    case 'unauthenticated':
    case 'csrf':
      return row('signin', 'Sign in again to use AI.');
    default:
      return row('generic', 'Something went wrong. Nothing was changed.', { retry: true });
  }
}

/** The whole row as one plain sentence, for a test or a label. */
export function errorPlain(v: ErrorView): string {
  return [v.text, v.link ? `${v.link.before}${v.link.label}${v.link.after}` : v.note].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------- preview and toasts

/** The summary line of a preview: "6 stickies in a new frame “Summary”", "6 new stickies", "Moves 9 stickies into 3 groups". */
export function previewLine(p: AiProposal): string {
  if (p.kind === 'group') return `Moves ${plural(groupedStickies(p), 'sticky', 'stickies')} into ${plural(p.groups.length, 'group', 'groups')}`;
  const n = p.objects.length;
  return p.frame ? `${plural(n, 'sticky', 'stickies')} in a new frame “${p.frame.title}”` : `${n} new ${n === 1 ? 'sticky' : 'stickies'}`;
}

function groupedStickies(p: Extract<AiProposal, { kind: 'group' }>): number {
  return p.groups.reduce((sum, g) => sum + g.ids.length, 0);
}

/** The toast after Add: "Added 6 stickies." or "Moved 9 stickies into 3 groups." */
export function addedMessage(p: AiProposal): string {
  if (p.kind === 'group') return `Moved ${plural(groupedStickies(p), 'sticky', 'stickies')} into ${plural(p.groups.length, 'group', 'groups')}.`;
  return `Added ${plural(p.objects.length, 'sticky', 'stickies')}.`;
}

/** The toast when a click lost the race: who settled the run, and how. `me` is this person's id, for a run settled from another tab. */
export function settledMessage(action: string | null, by: { id: string | null; name: string | null } | null, me: string | null = null): string {
  if (by?.id && me && by.id === me) {
    if (action === 'accept') return 'Your preview was already added.';
    if (action === 'discard') return 'Your preview was already discarded.';
  }
  const who = by?.name?.trim() || 'Someone';
  if (action === 'accept') return `${who} added your preview.`;
  if (action === 'discard') return `${who} discarded your preview.`;
  if (action === 'expired') return 'Your preview expired. Run it again.';
  if (action === 'failed') return 'That AI run did not finish. Run it again.';
  return 'Your preview was already settled.';
}

// ---------------------------------------------------------------- history

export const HISTORY_MAX = 20;
export const HISTORY_SHOWN = 6;

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Newline-separated, newest first; blanks and repeats dropped, at most 20. */
export function parseHistory(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split('\n')) {
    const p = oneLine(part);
    if (p && !out.includes(p)) out.push(p);
  }
  return out.slice(0, HISTORY_MAX);
}

export const serializeHistory = (list: readonly string[]): string => list.join('\n');

/** The prompt goes to the front; an earlier copy of it goes away; the list stays within 20. */
export function pushHistory(list: readonly string[], prompt: string): string[] {
  const p = oneLine(prompt);
  if (!p) return [...list];
  return [p, ...list.filter((x) => x !== p)].slice(0, HISTORY_MAX);
}

/** Up and Down walk the list in an empty prompt, or while already walking it. Typing leaves history mode (index back to -1). */
export const canWalkHistory = (prompt: string, index: number): boolean => prompt === '' || index >= 0;

/** Up goes to an older prompt (the first press fills the newest); Down goes newer, and past the newest empties the prompt. */
export function stepHistory(list: readonly string[], index: number, dir: 'up' | 'down'): { index: number; text: string } {
  if (!list.length) return { index: -1, text: '' };
  const next = dir === 'up' ? Math.min(list.length - 1, index + 1) : Math.max(-1, index - 1);
  return { index: next, text: next < 0 ? '' : list[next] };
}

// ---------------------------------------------------------------- dock and drag

export interface Pos {
  left: number;
  bottom: number;
}

export const EDGE = 8;
export const KEY_STEP = 8;
export const KEY_STEP_BIG = 32;

/** Keeps the bar inside the board, 8px from each edge and outside any safe-area insets. */
export function clampPos(
  p: Pos, size: { w: number; h: number }, area: { w: number; h: number },
  safe: { top?: number; right?: number; bottom?: number; left?: number } = {},
): Pos {
  return {
    left: Math.round(Math.max(EDGE + (safe.left ?? 0), Math.min(area.w - size.w - EDGE - (safe.right ?? 0), p.left))),
    bottom: Math.round(Math.max(EDGE + (safe.bottom ?? 0), Math.min(area.h - size.h - EDGE - (safe.top ?? 0), p.bottom))),
  };
}

/** "left,bottom" in px, or null when the text is not that. */
export function parsePos(raw: string | null | undefined): Pos | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(raw ?? '');
  return m ? { left: Number(m[1]), bottom: Number(m[2]) } : null;
}

export const formatPos = (p: Pos): string => `${Math.round(p.left)},${Math.round(p.bottom)}`;

/** The position after the pointer moved by (dx, dy) from where the drag began: down is less bottom. */
export const dragPos = (start: Pos, dx: number, dy: number): Pos => ({ left: start.left + dx, bottom: start.bottom - dy });

/** Arrow keys on the grip move the bar 8px, 32px with Shift. Null for any other key. */
export function arrowPos(p: Pos, key: string, shift: boolean): Pos | null {
  const step = shift ? KEY_STEP_BIG : KEY_STEP;
  const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
  const move = d[key];
  return move ? { left: p.left + move[0], bottom: p.bottom + move[1] } : null;
}

export const NARROW_DOCK = 1000;
export const PHONE_DOCK = 860;
const STACK_GAP = 8;

/**
 * The docked bar's bottom offset: 16px, or 64px at 1000px and below (above the zoom tray), plus the safe bottom inset,
 * and 8px above the highest of the bars below it (the session bar, a poll card). `tops` are those bars' top edges, `boardBottom` the board's, in viewport px.
 */
export function dockBottom(o: { narrow: boolean; boardBottom: number; tops: readonly number[]; safeBottom?: number }): number {
  let bottom = (o.narrow ? 64 : 16) + (o.safeBottom ?? 0);
  for (const top of o.tops) bottom = Math.max(bottom, Math.round(o.boardBottom - top + STACK_GAP));
  return bottom;
}

/** `--ai-top`: how far from the board's bottom edge the toast and the focus cards must start to clear the bar (or its button). */
export const aiTop = (boardBottom: number, barTop: number): number => Math.max(0, Math.round(boardBottom - barTop + STACK_GAP));
