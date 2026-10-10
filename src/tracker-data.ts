import {
  TrackerError,
  type TrackerBulkPatch,
  type TrackerBulkResult,
  type TrackerComment,
  type TrackerCommentPage,
  type TrackerCreateInput,
  type TrackerEventPage,
  type TrackerFacets,
  type TrackerFeed,
  type TrackerInboxPage,
  type TrackerListQuery,
  type TrackerMeta,
  type TrackerNotificationPrefs,
  type TrackerPatch,
  type TrackerPriority,
  type TrackerRelationKind,
  type TrackerSort,
  type TrackerState,
  type TrackerStateCategory,
  type TrackerTicket,
  type TrackerTicketDetail,
  type TrackerTicketListPage,
  type TrackerUpdatedTickets,
} from './tracker-types';
import type { TrackerErrorCode } from './tracker-types';

export * from './tracker-types';

export interface TrackerRequestOptions { signal?: AbortSignal }
export interface TrackerListOptions extends TrackerRequestOptions {}
export interface TrackerPageOptions extends TrackerRequestOptions { before?: string | number; limit?: number }
export interface TrackerInboxQuery { limit?: number; before?: string; unread?: boolean }
export type TrackerInboxReadInput = { ids: string[] } | { all: true };
export interface TrackerBulkInput { keys: string[]; patch: TrackerBulkPatch }

/** Typed transport for every public tracker endpoint used by the app. */
export interface TrackerApi {
  meta(options?: TrackerRequestOptions): Promise<TrackerMeta>;
  listTickets(query?: TrackerListQuery, options?: TrackerListOptions): Promise<TrackerTicketListPage>;
  ticketsUpdatedSince(seq: number, options?: TrackerRequestOptions): Promise<TrackerUpdatedTickets>;
  createTicket(input: TrackerCreateInput, options?: TrackerRequestOptions): Promise<{ ticket: TrackerTicket }>;
  getTicket(key: string, options?: TrackerRequestOptions): Promise<TrackerTicketDetail>;
  ticketComments(key: string, page?: TrackerPageOptions): Promise<TrackerCommentPage>;
  ticketEvents(key: string, page?: TrackerPageOptions): Promise<TrackerEventPage>;
  patchTicket(key: string, patch: TrackerPatch, options?: TrackerRequestOptions): Promise<{ ticket: TrackerTicket }>;
  transitionTicket(key: string, state: string, options?: TrackerRequestOptions): Promise<{ ticket: TrackerTicket }>;
  addComment(key: string, input: { body: string; clientId: string }, options?: TrackerRequestOptions): Promise<{ comment: TrackerComment; ticket: TrackerTicket }>;
  editComment(id: string, body: string, options?: TrackerRequestOptions): Promise<{ comment: TrackerComment }>;
  deleteComment(id: string, options?: TrackerRequestOptions): Promise<{ deleted: true } | void>;
  setSubscription(key: string, subscribed: boolean, options?: TrackerRequestOptions): Promise<{ subscribed: boolean }>;
  feed(since: number, options?: TrackerRequestOptions): Promise<TrackerFeed>;
  bulkTickets(input: TrackerBulkInput, options?: TrackerRequestOptions): Promise<TrackerBulkResult>;
  archiveTicket(key: string, options?: TrackerRequestOptions): Promise<{ ticket: TrackerTicket }>;
  restoreTicket(key: string, options?: TrackerRequestOptions): Promise<{ ticket: TrackerTicket }>;
  addRelation(key: string, relation: { kind: TrackerRelationKind; key: string }, options?: TrackerRequestOptions): Promise<{ ticket: TrackerTicket }>;
  removeRelation(key: string, relation: { kind: TrackerRelationKind; key: string }, options?: TrackerRequestOptions): Promise<{ ticket: TrackerTicket }>;
  inbox(query?: TrackerInboxQuery, options?: TrackerRequestOptions): Promise<TrackerInboxPage>;
  inboxUnread(options?: TrackerRequestOptions): Promise<{ unread: number }>;
  markInboxRead(input: TrackerInboxReadInput, options?: TrackerRequestOptions): Promise<{ updated: number; unread: number }>;
  notificationPrefs(options?: TrackerRequestOptions): Promise<TrackerNotificationPrefs>;
  updateNotificationPrefs(patch: TrackerNotificationPrefs, options?: TrackerRequestOptions): Promise<TrackerNotificationPrefs>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrorCode(value: unknown): value is TrackerErrorCode {
  return value === 'invalid_input' || value === 'invalid_filter' || value === 'not_found'
    || value === 'forbidden' || value === 'conflict' || value === 'read_only'
    || value === 'limit_exceeded' || value === 'rate_limited' || value === 'internal'
    || value === 'offline' || value === 'network';
}

function trackerHttpError(status: number, body: unknown): TrackerError {
  const fields = isRecord(body) ? body : {};
  const rawCode = fields.error;
  let code: TrackerErrorCode;
  if (status === 404) code = 'not_found';
  else if (isErrorCode(rawCode)) code = rawCode;
  else if (status === 403) code = 'forbidden';
  else if (status === 409) code = 'conflict';
  else if (status === 429) code = 'rate_limited';
  else if (status === 400 || status === 422) code = 'invalid_input';
  else code = 'internal';
  const message = typeof fields.message === 'string' ? fields.message : code;
  const path = typeof fields.path === 'string' ? fields.path : undefined;
  const current = isRecord(fields.ticket) ? fields.ticket as unknown as TrackerTicket : undefined;
  return new TrackerError(code, message, { path, current, status });
}

/** JSON transport matching src/api.ts same-origin and CSRF conventions. */
export function createHttpTrackerApi(fetchFn: typeof fetch = fetch): TrackerApi {
  async function request<T>(method: string, path: string, body?: unknown, options: TrackerRequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const init: RequestInit = { method, credentials: 'same-origin', headers, signal: options.signal };
    if (method !== 'GET') headers['x-tabula'] = '1';
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetchFn(path, init);
    } catch (error) {
      if (error instanceof TrackerError) throw error;
      throw new TrackerError('network', error instanceof Error ? error.message : 'network');
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (!response.ok) throw trackerHttpError(response.status, undefined);
      throw new TrackerError('network', error instanceof Error ? error.message : 'network');
    }
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) as unknown : undefined;
    } catch {
      if (!response.ok) throw trackerHttpError(response.status, undefined);
      throw new TrackerError('internal', 'The tracker returned an invalid JSON response.', { status: response.status });
    }
    if (!response.ok) throw trackerHttpError(response.status, payload);
    return payload as T;
  }

  const segment = (value: string) => encodeURIComponent(value);
  const queryString = (entries: Array<[string, string | number | boolean | undefined]>) => {
    const params = new URLSearchParams();
    for (const [key, value] of entries) if (value !== undefined && value !== '') params.append(key, String(value));
    const result = params.toString();
    return result ? `?${result}` : '';
  };

  return {
    meta: (options) => request('GET', '/api/tracker/meta', undefined, options),
    listTickets: (query = {}, options) => {
      const filters = typeof query.filter === 'string' ? [query.filter] : query.filter ?? [];
      return request('GET', `/api/tracker/tickets${queryString([
        ...filters.map((filter): [string, string] => ['filter', filter]),
        ['q', query.q], ['limit', query.limit], ['cursor', query.cursor],
        ['sort', query.sort ? `${query.sort.field}:${query.sort.direction}` : undefined],
        ['group', query.group ?? undefined], ['facets', query.includeFacets ? 1 : undefined],
      ])}`, undefined, options);
    },
    ticketsUpdatedSince: (seq, options) => request('GET', `/api/tracker/tickets${queryString([['updatedSince', seq]])}`, undefined, options),
    createTicket: (input, options) => request('POST', '/api/tracker/tickets', input, options),
    getTicket: (key, options) => request('GET', `/api/tracker/tickets/${segment(key)}`, undefined, options),
    ticketComments: (key, page = {}) => request('GET', `/api/tracker/tickets/${segment(key)}/comments${queryString([['before', page.before], ['limit', page.limit]])}`, undefined, page),
    ticketEvents: (key, page = {}) => request('GET', `/api/tracker/tickets/${segment(key)}/events${queryString([['before', page.before], ['limit', page.limit]])}`, undefined, page),
    patchTicket: (key, patch, options) => request('PATCH', `/api/tracker/tickets/${segment(key)}`, patch, options),
    transitionTicket: (key, state, options) => request('POST', `/api/tracker/tickets/${segment(key)}/transition`, { state }, options),
    addComment: (key, input, options) => request('POST', `/api/tracker/tickets/${segment(key)}/comments`, input, options),
    editComment: (id, body, options) => request('PATCH', `/api/tracker/comments/${segment(id)}`, { body }, options),
    deleteComment: (id, options) => request('DELETE', `/api/tracker/comments/${segment(id)}`, undefined, options),
    setSubscription: (key, subscribed, options) => request(subscribed ? 'PUT' : 'DELETE', `/api/tracker/tickets/${segment(key)}/subscription`, undefined, options),
    feed: (since, options) => request('GET', `/api/tracker/feed${queryString([['since', since]])}`, undefined, options),
    bulkTickets: (input, options) => request('POST', '/api/tracker/tickets/bulk', input, options),
    archiveTicket: (key, options) => request('POST', `/api/tracker/tickets/${segment(key)}/archive`, {}, options),
    restoreTicket: (key, options) => request('POST', `/api/tracker/tickets/${segment(key)}/restore`, {}, options),
    addRelation: (key, relation, options) => request('POST', `/api/tracker/tickets/${segment(key)}/relations`, relation, options),
    removeRelation: (key, relation, options) => request('DELETE', `/api/tracker/tickets/${segment(key)}/relations`, relation, options),
    inbox: (query = {}, options) => request('GET', `/api/tracker/inbox${queryString([
      ['limit', query.limit], ['before', query.before], ['unread', query.unread ? 1 : undefined],
    ])}`, undefined, options),
    inboxUnread: (options) => request('GET', '/api/tracker/inbox/unread', undefined, options),
    markInboxRead: (input, options) => request('POST', '/api/tracker/inbox/read', input, options),
    notificationPrefs: (options) => request('GET', '/api/tracker/notification-prefs', undefined, options),
    updateNotificationPrefs: (patch, options) => request('PUT', '/api/tracker/notification-prefs', patch, options),
  };
}

export interface ParsedTrackerFilter {
  assignee?: string;
  state: string[];
  label: string[];
  due?: string;
  archived?: boolean;
  invalid: string[];
}

/** Parses the supported search tokens while retaining unknown tokens for an error display. */
export function parseFilter(input: string | readonly string[] | undefined): ParsedTrackerFilter {
  const parts: readonly string[] = typeof input === 'string' ? input.split(/\s+/) : input ?? [];
  const tokens = parts.map((part: string) => part.trim()).filter(Boolean);
  const parsed: ParsedTrackerFilter = { state: [], label: [], invalid: [] };
  for (const token of tokens) {
    const separator = token.indexOf(':');
    if (separator < 1) { parsed.invalid.push(token); continue; }
    const name = token.slice(0, separator).toLowerCase();
    const value = token.slice(separator + 1);
    if (name === 'assignee' && value) parsed.assignee = value;
    else if (name === 'state' && value) parsed.state.push(value);
    else if (name === 'label' && value) parsed.label.push(value);
    else if (name === 'due' && value && (value === 'overdue' || value === 'today' || value === 'no-date'
      || (value.startsWith('before-') && isValidDueDate(value.slice(7))))) parsed.due = value;
    else if (name === 'is' && value === 'archived') parsed.archived = true;
    else parsed.invalid.push(token);
  }
  return parsed;
}

export function formatFilter(filter: Partial<ParsedTrackerFilter> | string | readonly string[] | undefined): string[] {
  if (filter === undefined) return [];
  if (typeof filter === 'string') return filter.split(/\s+/).filter(Boolean);
  if (Array.isArray(filter)) return [...filter] as string[];
  const fields = filter as Partial<ParsedTrackerFilter>;
  const tokens: string[] = [];
  if (fields.assignee) tokens.push(`assignee:${fields.assignee}`);
  for (const state of fields.state ?? []) tokens.push(`state:${state}`);
  for (const label of fields.label ?? []) tokens.push(`label:${label}`);
  if (fields.due) tokens.push(`due:${fields.due}`);
  if (fields.archived) tokens.push('is:archived');
  tokens.push(...(fields.invalid ?? []));
  return tokens;
}

const TICKET_KEY_RE = /^[A-Z]{2,5}-[1-9]\d*$/i;
export function isTicketKey(value: unknown): value is string {
  return typeof value === 'string' && TICKET_KEY_RE.test(value.trim());
}
export function ticketKeyFromText(value: string): string | null {
  const match = value.match(/\b[A-Z]{2,5}-[1-9]\d*\b/i);
  return match?.[0].toUpperCase() ?? null;
}

export function statesByCategory(states: readonly TrackerState[], category: TrackerStateCategory): TrackerState[] {
  return states.filter((state) => state.category === category).slice().sort((a, b) => a.position - b.position);
}
export function isStateInCategory(state: Pick<TrackerState, 'category'> | TrackerTicket['state'] | null | undefined, category: TrackerStateCategory): boolean {
  return state?.category === category;
}
export function isCompletedState(state: Pick<TrackerState, 'category'> | TrackerTicket['state'] | null | undefined): boolean {
  return isStateInCategory(state, 'completed');
}
export function isCancelledState(state: Pick<TrackerState, 'category'> | TrackerTicket['state'] | null | undefined): boolean {
  return isStateInCategory(state, 'canceled');
}

export const PRIORITY_NAMES: readonly TrackerPriority[] = ['none', 'urgent', 'high', 'medium', 'low'];
export function priorityToInt(priority: TrackerPriority): number { return PRIORITY_NAMES.indexOf(priority); }
export function priorityFromInt(priority: number): TrackerPriority {
  return PRIORITY_NAMES[Math.min(PRIORITY_NAMES.length - 1, Math.max(0, Math.trunc(priority)))] ?? 'none';
}

export function isValidDueDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
export function isDueDateOverdue(due: string | null | undefined, today: string): boolean {
  return Boolean(due && isValidDueDate(due) && isValidDueDate(today) && due < today);
}
export function dueDateStatus(due: string | null | undefined, today: string): 'none' | 'overdue' | 'today' | 'upcoming' {
  if (!due || !isValidDueDate(due) || !isValidDueDate(today)) return 'none';
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  return 'upcoming';
}

export interface FilterContext { me?: { userId: string } | string | null; today: string }
export function matchesFilters(ticket: TrackerTicket, filters: string | readonly string[] | ParsedTrackerFilter | undefined, ctx: FilterContext): boolean {
  const parsed = typeof filters === 'object' && filters !== null && !Array.isArray(filters)
    ? filters as ParsedTrackerFilter
    : parseFilter(filters as string | readonly string[] | undefined);
  if (parsed.invalid.length) return false;
  const isArchiveQuery = parsed.archived === true;
  if (isArchiveQuery ? ticket.archivedAt === null : ticket.archivedAt !== null) return false;
  if (parsed.assignee) {
    const wanted = parsed.assignee.toLocaleLowerCase();
    const me = typeof ctx.me === 'string' ? ctx.me : ctx.me?.userId;
    if (wanted === 'me') { if (!me || ticket.assignee?.userId !== me) return false; }
    else if (!ticket.assignee || ![ticket.assignee.userId, ticket.assignee.name].some((v) => v.toLocaleLowerCase() === wanted)) return false;
  }
  if (parsed.state.length && !parsed.state.some((wanted) => [ticket.state.id, ticket.state.key, ticket.state.name, ticket.state.category].some((value) => value.toLocaleLowerCase() === wanted.toLocaleLowerCase()))) return false;
  if (parsed.label.length && !parsed.label.every((wanted) => ticket.labels.some((label) => [label.id, label.name].some((value) => value.toLocaleLowerCase() === wanted.toLocaleLowerCase())))) return false;
  if (parsed.due === 'overdue' && !isDueDateOverdue(ticket.due, ctx.today)) return false;
  if (parsed.due === 'today' && ticket.due !== ctx.today) return false;
  if (parsed.due === 'no-date' && ticket.due !== null) return false;
  if (parsed.due?.startsWith('before-') && (!ticket.due || ticket.due >= parsed.due.slice(7))) return false;
  return true;
}

function compareText(a: string, b: string): number { return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }); }
export function compareTickets(a: TrackerTicket, b: TrackerTicket, sort: TrackerSort = { field: 'updatedAt', direction: 'desc' }): number {
  const sign = sort.direction === 'desc' ? -1 : 1;
  const field = sort.field;
  let cmp = 0;
  if (field === 'key' || field === 'title') cmp = compareText(a[field], b[field]);
  else if (field === 'priority') cmp = (priorityToInt(a.priority) - priorityToInt(b.priority));
  else if (field === 'assignee') cmp = compareText(a.assignee?.name ?? '', b.assignee?.name ?? '');
  else if (field === 'state') cmp = compareText(a.state.name, b.state.name);
  else if (field === 'due') cmp = compareText(a.due ?? '9999-99-99', b.due ?? '9999-99-99');
  else cmp = a[field] - b[field];
  return cmp === 0 ? compareText(a.key, b.key) : cmp * sign;
}

export function normalizeListQuery(query: TrackerListQuery = {}): string {
  const filters = formatFilter(query.filter).map((part) => part.trim().toLocaleLowerCase()).filter(Boolean).sort((a, b) => a.localeCompare(b));
  const sort = query.sort ? `${query.sort.field}:${query.sort.direction}` : 'updatedAt:desc';
  return JSON.stringify({ filters, q: (query.q ?? '').trim().toLocaleLowerCase(), sort, group: query.group?.trim().toLocaleLowerCase() ?? null });
}

export function cloneTrackerData<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneTrackerData(item)) as T;
  if (value && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = cloneTrackerData(item);
    return copy as T;
  }
  return value;
}

export interface TrackerStoreOptions {
  pollMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  isVisible?: () => boolean;
  isOnline?: () => boolean;
}

export interface TrackerTicketCache {
  ticket?: TrackerTicket;
  detail?: TrackerTicketDetail;
  loading: boolean;
  error?: TrackerError;
  conflict?: TrackerTicket;
  pending: boolean;
  offlineQueued: boolean;
  subscribed?: boolean;
}
export interface TrackerListCache {
  query: TrackerListQuery;
  key: string;
  tickets: TrackerTicket[];
  nextCursor: string | null;
  facets?: TrackerFacets;
  loading: boolean;
  loadingMore: boolean;
  error?: TrackerError;
}
export interface TrackerStoreSnapshot {
  meta?: TrackerMeta;
  metaLoading: boolean;
  metaError?: TrackerError;
  readOnly: boolean;
  tickets: Record<string, TrackerTicketCache>;
  lists: Record<string, TrackerListCache>;
  feedSeq: number;
}

export interface TrackerUndoBatch {
  batchId: string;
  before: TrackerBulkResult['before'];
}

export interface TrackerStore {
  subscribe(listener: (snapshot: TrackerStoreSnapshot) => void): () => void;
  snapshot(): TrackerStoreSnapshot;
  loadMeta(force?: boolean): Promise<TrackerMeta>;
  loadList(query?: TrackerListQuery, options?: { force?: boolean }): Promise<TrackerListCache>;
  loadMore(query?: TrackerListQuery): Promise<TrackerListCache>;
  list(query?: TrackerListQuery): TrackerListCache;
  watchList(query: TrackerListQuery, listener: (state: TrackerListCache) => void): () => void;
  ticket(key: string): TrackerTicketCache;
  loadTicket(key: string, force?: boolean): Promise<TrackerTicketDetail>;
  watchTicket(key: string, listener: (state: TrackerTicketCache) => void): () => void;
  createTicket(input: Omit<TrackerCreateInput, 'idempotencyKey'> & { idempotencyKey?: string }): Promise<TrackerTicket>;
  updateTicket(key: string, patch: Omit<TrackerPatch, 'ifUpdatedSeq'>): Promise<TrackerTicket>;
  transitionTicket(key: string, state: string): Promise<TrackerTicket>;
  addComment(key: string, body: string, clientId?: string): Promise<TrackerComment>;
  setSubscription(key: string, subscribed: boolean): Promise<boolean>;
  bulk(keys: string[], patch: TrackerBulkPatch): Promise<TrackerUndoBatch>;
  undo(batch: TrackerUndoBatch): Promise<TrackerBulkResult>;
  /** Replays this process-local queue after reconnect. V1 does not persist queued edits across reloads. */
  replayOfflineQueue(): Promise<void>;
  addRelation(key: string, relation: { kind: TrackerRelationKind; key: string }): Promise<TrackerTicket>;
  removeRelation(key: string, relation: { kind: TrackerRelationKind; key: string }): Promise<TrackerTicket>;
  destroy(): void;
}

interface QueuedEdit { kind: 'patch' | 'transition' | 'comment' | 'subscription'; value: unknown; baseSeq: number }

function asTrackerError(error: unknown): TrackerError {
  if (error instanceof TrackerError) return error;
  return new TrackerError('network', error instanceof Error ? error.message : 'network');
}

function cacheTicketKey(key: string): string { return key.trim().toUpperCase(); }
function emptyTicketCache(): TrackerTicketCache {
  return { loading: false, pending: false, offlineQueued: false };
}
function emptyListCache(query: TrackerListQuery, key: string): TrackerListCache {
  return { query: cloneTrackerData(query), key, tickets: [], nextCursor: null, loading: false, loadingMore: false };
}
function makeLocalId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '');
  return `${prefix}-${random ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`}`;
}

function ticketWithPatch(ticket: TrackerTicket, patch: TrackerBulkPatch, meta: TrackerMeta | undefined, now: number): TrackerTicket {
  const next = cloneTrackerData(ticket);
  if (patch.title !== undefined) Object.assign(next, { title: patch.title });
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.due !== undefined) next.due = patch.due;
  if (patch.parent !== undefined) next.parent = patch.parent;
  if (patch.labels !== undefined) {
    next.labels = patch.labels.map((name) => meta?.labels.find((label) => label.id === name || label.name.toLocaleLowerCase() === name.toLocaleLowerCase()))
      .filter((label): label is NonNullable<typeof label> => Boolean(label))
      .map((label) => cloneTrackerData(label));
  }
  if (patch.assignee !== undefined) {
    if (patch.assignee === null || patch.assignee === '') next.assignee = null;
    else {
      const member = meta?.members.find((candidate) => candidate.userId === patch.assignee || candidate.name.toLocaleLowerCase() === patch.assignee?.toLocaleLowerCase());
      if (member) next.assignee = { userId: member.userId, name: member.name };
    }
  }
  if (patch.archived !== undefined) next.archivedAt = patch.archived ? (next.archivedAt ?? now) : null;
  next.updatedAt = now;
  return next;
}

function patchValuesBefore(ticket: TrackerTicket, patch: TrackerBulkPatch): TrackerBulkPatch {
  const before: TrackerBulkPatch = {};
  if ('title' in patch) Object.assign(before, { title: ticket.title });
  if ('description' in patch) before.description = ticket.description;
  if ('priority' in patch) before.priority = ticket.priority;
  if ('assignee' in patch) before.assignee = ticket.assignee?.userId ?? null;
  if ('labels' in patch) before.labels = ticket.labels.map((label) => label.name);
  if ('due' in patch) before.due = ticket.due;
  if ('parent' in patch) before.parent = ticket.parent;
  if ('archived' in patch) before.archived = ticket.archivedAt !== null;
  return before;
}

/** Creates the framework-free reactive cache used by the tracker UI. */
export function createTrackerStore(api: TrackerApi, options: TrackerStoreOptions = {}): TrackerStore {
  const pollMs = Math.max(1, options.pollMs ?? 5000);
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, delay: number) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const isVisible = options.isVisible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const isOnline = options.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const generalListeners = new Set<(snapshot: TrackerStoreSnapshot) => void>();
  const ticketListeners = new Map<string, Set<(state: TrackerTicketCache) => void>>();
  const listListeners = new Map<string, Set<(state: TrackerListCache) => void>>();
  const ticketCaches = new Map<string, TrackerTicketCache>();
  const listCaches = new Map<string, TrackerListCache>();
  const loadedLists = new Set<string>();
  const watchQueries = new Map<string, TrackerListQuery>();
  const offlineQueue = new Map<string, QueuedEdit[]>();
  const blockedQueue = new Set<string>();
  let meta: TrackerMeta | undefined;
  let metaLoading = false;
  let metaError: TrackerError | undefined;
  let readOnly = false;
  let feedSeq = 0;
  let timer: unknown;
  let timerScheduled = false;
  let pollErrors = 0;
  let destroyed = false;
  let replaying = false;

  function snapshot(): TrackerStoreSnapshot {
    const tickets: Record<string, TrackerTicketCache> = {};
    const lists: Record<string, TrackerListCache> = {};
    for (const [key, value] of ticketCaches) tickets[key] = cloneTrackerData(value);
    for (const [key, value] of listCaches) lists[key] = cloneTrackerData(value);
    return { meta: meta ? cloneTrackerData(meta) : undefined, metaLoading, metaError, readOnly, tickets, lists, feedSeq };
  }

  function notify(): void {
    const full = snapshot();
    for (const listener of generalListeners) listener(cloneTrackerData(full));
    for (const [key, listeners] of ticketListeners) {
      const state = ticketCaches.get(key) ?? emptyTicketCache();
      for (const listener of listeners) listener(cloneTrackerData(state));
    }
    for (const [key, listeners] of listListeners) {
      const state = listCaches.get(key) ?? emptyListCache({}, key);
      for (const listener of listeners) listener(cloneTrackerData(state));
    }
  }

  function ticketCache(key: string): TrackerTicketCache {
    const normalized = cacheTicketKey(key);
    let state = ticketCaches.get(normalized);
    if (!state) { state = emptyTicketCache(); ticketCaches.set(normalized, state); }
    return state;
  }

  function listCache(query: TrackerListQuery = {}): TrackerListCache {
    const key = normalizeListQuery(query);
    let state = listCaches.get(key);
    if (!state) { state = emptyListCache(query, key); listCaches.set(key, state); }
    return state;
  }

  function querySnippet(ticket: TrackerTicket, query: string): string | null {
    const terms = query.trim().split(/\s+/).filter(Boolean);
    const cached = ticketCaches.get(cacheTicketKey(ticket.key))?.detail?.comments ?? [];
    const source = [ticket.title, ticket.description, ...cached.filter((comment) => !comment.deleted).map((comment) => comment.body)]
      .find((text) => terms.every((term) => text.toLocaleLowerCase().includes(term.toLocaleLowerCase())));
    if (source === undefined) return null;
    let snippet = source.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    for (const term of terms.sort((a, b) => b.length - a.length)) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      snippet = snippet.replace(new RegExp(escaped, 'ig'), (matched) => `<mark>${matched}</mark>`);
    }
    return snippet;
  }

  function updateListRows(ticket: TrackerTicket): void {
    const today = new Date(now()).toISOString().slice(0, 10);
    for (const state of listCaches.values()) {
      const index = state.tickets.findIndex((row) => row.key === ticket.key);
      if (index < 0) continue;
      let row = cloneTrackerData(ticket);
      if (!matchesFilters(row, state.query.filter, { me: meta?.me.userId, today })) {
        state.tickets.splice(index, 1);
        continue;
      }
      if (state.query.q) {
        const snippet = querySnippet(row, state.query.q);
        if (snippet === null) { state.tickets.splice(index, 1); continue; }
        row.snippet = snippet;
      }
      state.tickets[index] = row;
      state.tickets.sort((a, b) => compareTickets(a, b, state.query.sort ?? { field: 'updatedAt', direction: 'desc' }));
    }
  }

  function saveTicket(ticket: TrackerTicket, options: { preserveLocal?: boolean } = {}): void {
    let shouldUpdateLists = true;
    for (const ref of new Set([ticket.key, ...(ticket.aliases ?? [])])) {
      const state = ticketCache(ref);
      if (options.preserveLocal && state.pending) { shouldUpdateLists = false; continue; }
      state.ticket = cloneTrackerData(ticket);
    }
    if (shouldUpdateLists) updateListRows(ticket);
  }

  function setReadonlyFrom(error: TrackerError): void {
    if (error.code === 'read_only') readOnly = true;
  }

  function assertWritable(): void {
    if (readOnly || meta?.me.canWrite === false) {
      readOnly = true;
      throw new TrackerError('read_only', 'You do not have permission to change tracker tickets.');
    }
  }

  function watchedCount(): number {
    let count = 0;
    for (const listeners of ticketListeners.values()) count += listeners.size;
    for (const listeners of listListeners.values()) count += listeners.size;
    return count;
  }

  function stopPoll(): void {
    if (!timerScheduled) return;
    clearTimer(timer);
    timerScheduled = false;
    timer = undefined;
  }

  function schedulePoll(delay = pollMs): void {
    if (destroyed || timerScheduled || watchedCount() === 0) return;
    timerScheduled = true;
    timer = setTimer(() => {
      timerScheduled = false;
      timer = undefined;
      void poll();
    }, delay);
  }

  async function poll(): Promise<void> {
    if (destroyed || watchedCount() === 0) return;
    if (!isVisible()) { schedulePoll(pollMs); return; }
    try {
      const page = await api.feed(feedSeq);
      feedSeq = Math.max(feedSeq, page.seq, ...page.events.map((event) => event.id));
      pollErrors = 0;
      const changedKeys = new Set(page.events.map((event) => cacheTicketKey(event.ticketKey)));
      for (const key of changedKeys) {
        if (ticketListeners.has(key)) void loadTicket(key, true).catch(() => undefined);
      }
      if (page.events.length > 0) {
        for (const [key, query] of watchQueries) {
          if (listListeners.has(key)) void loadList(query, { force: true }).catch(() => undefined);
        }
      }
      notify();
      schedulePoll(pollMs);
    } catch {
      pollErrors += 1;
      const backoff = Math.min(pollMs * (2 ** Math.min(pollErrors, 6)), 60_000);
      schedulePoll(backoff);
    }
  }

  function startWatching(): void { schedulePoll(pollMs); }

  async function loadMeta(force = false): Promise<TrackerMeta> {
    if (meta && !force) return cloneTrackerData(meta);
    metaLoading = true;
    metaError = undefined;
    notify();
    try {
      meta = await api.meta();
      readOnly = !meta.me.canWrite;
      metaLoading = false;
      notify();
      return cloneTrackerData(meta);
    } catch (caught) {
      metaLoading = false;
      metaError = asTrackerError(caught);
      setReadonlyFrom(metaError);
      notify();
      throw metaError;
    }
  }

  async function loadList(query: TrackerListQuery = {}, loadOptions: { force?: boolean } = {}): Promise<TrackerListCache> {
    const state = listCache(query);
    if ((loadedLists.has(state.key) || state.loading) && !loadOptions.force) return cloneTrackerData(state);
    state.loading = true;
    state.error = undefined;
    notify();
    try {
      const page: TrackerTicketListPage = await api.listTickets({ ...query, cursor: undefined });
      state.tickets = page.tickets.map((ticket) => {
        const cached = ticketCache(ticket.key);
        return cached.pending && cached.ticket ? cloneTrackerData(cached.ticket) : cloneTrackerData(ticket);
      });
      state.nextCursor = page.nextCursor;
      state.facets = page.facets ? cloneTrackerData(page.facets) : undefined;
      state.loading = false;
      state.loadingMore = false;
      loadedLists.add(state.key);
      for (const ticket of page.tickets) saveTicket(ticket, { preserveLocal: true });
      notify();
      return cloneTrackerData(state);
    } catch (caught) {
      state.loading = false;
      state.loadingMore = false;
      state.error = asTrackerError(caught);
      setReadonlyFrom(state.error);
      notify();
      throw state.error;
    }
  }

  async function loadMore(query: TrackerListQuery = {}): Promise<TrackerListCache> {
    const state = listCache(query);
    if (!state.nextCursor || state.loadingMore) return cloneTrackerData(state);
    state.loadingMore = true;
    state.error = undefined;
    notify();
    try {
      const page = await api.listTickets({ ...query, cursor: state.nextCursor });
      const seen = new Set(state.tickets.map((ticket) => ticket.key));
      state.tickets = [...state.tickets, ...page.tickets.filter((ticket) => !seen.has(ticket.key)).map((ticket) => {
        const cached = ticketCache(ticket.key);
        return cached.pending && cached.ticket ? cloneTrackerData(cached.ticket) : cloneTrackerData(ticket);
      })];
      state.nextCursor = page.nextCursor;
      state.facets = page.facets ? cloneTrackerData(page.facets) : state.facets;
      state.loadingMore = false;
      for (const ticket of page.tickets) saveTicket(ticket, { preserveLocal: true });
      notify();
      return cloneTrackerData(state);
    } catch (caught) {
      state.loadingMore = false;
      state.error = asTrackerError(caught);
      setReadonlyFrom(state.error);
      notify();
      throw state.error;
    }
  }

  async function loadTicket(key: string, force = false): Promise<TrackerTicketDetail> {
    const state = ticketCache(key);
    if (state.detail && !force) return cloneTrackerData(state.detail);
    const hadConflict = state.conflict !== undefined;
    state.loading = true;
    if (!hadConflict) state.error = undefined;
    notify();
    try {
      const detail = await api.getTicket(key);
      const pendingTicket = state.pending ? state.ticket : undefined;
      const pendingSubscription = state.pending ? state.subscribed : undefined;
      state.ticket = cloneTrackerData(pendingTicket ?? detail.ticket);
      state.detail = { ...cloneTrackerData(detail), ticket: cloneTrackerData(pendingTicket ?? detail.ticket) };
      state.subscribed = pendingSubscription ?? detail.subscribed;
      state.detail.subscribed = state.subscribed;
      state.loading = false;
      if (hadConflict) {
        state.conflict = cloneTrackerData(detail.ticket);
        state.error = new TrackerError('conflict', 'This ticket changed while you were editing it.', { current: detail.ticket });
      }
      saveTicket(detail.ticket, { preserveLocal: true });
      notify();
      return cloneTrackerData(detail);
    } catch (caught) {
      state.loading = false;
      state.error = asTrackerError(caught);
      setReadonlyFrom(state.error);
      notify();
      throw state.error;
    }
  }

  function updateCacheTicket(state: TrackerTicketCache, ticket: TrackerTicket): void {
    state.ticket = cloneTrackerData(ticket);
    if (state.detail) state.detail = { ...state.detail, ticket: cloneTrackerData(ticket) };
    updateListRows(ticket);
  }

  function enqueue(key: string, edit: QueuedEdit): void {
    const normalized = cacheTicketKey(key);
    const queue = offlineQueue.get(normalized) ?? [];
    queue.push(edit);
    offlineQueue.set(normalized, queue);
    const state = ticketCache(normalized);
    state.pending = true;
    state.offlineQueued = true;
    state.error = undefined;
    notify();
  }

  async function handleMutationFailure(key: string, state: TrackerTicketCache, prior: TrackerTicketCache, error: TrackerError): Promise<never> {
    setReadonlyFrom(error);
    if (error.code === 'conflict') {
      let current = error.current;
      if (!current) {
        try { current = (await api.getTicket(key)).ticket; } catch { current = undefined; }
      }
      if (current) {
        updateCacheTicket(state, current);
        saveTicket(current);
        state.conflict = cloneTrackerData(current);
      } else {
        state.ticket = prior.ticket;
        state.detail = prior.detail;
        state.conflict = prior.ticket;
        if (prior.ticket) updateListRows(prior.ticket);
      }
      state.error = error;
      state.pending = false;
      state.offlineQueued = offlineQueue.has(cacheTicketKey(key));
      if (state.offlineQueued) blockedQueue.add(cacheTicketKey(key));
    } else {
      state.ticket = prior.ticket;
      state.detail = prior.detail;
      if (prior.ticket) updateListRows(prior.ticket);
      state.subscribed = prior.subscribed;
      state.conflict = prior.conflict;
      state.pending = prior.pending;
      state.offlineQueued = prior.offlineQueued;
      state.error = error;
    }
    notify();
    throw error;
  }

  async function ensureCurrent(key: string): Promise<TrackerTicket> {
    const cached = ticketCache(key).ticket;
    if (cached) return cached;
    return (await loadTicket(key)).ticket;
  }

  async function createTicket(input: Omit<TrackerCreateInput, 'idempotencyKey'> & { idempotencyKey?: string }): Promise<TrackerTicket> {
    if (!isOnline()) throw new TrackerError('offline', 'New tickets can only be created while online.');
    assertWritable();
    try {
      const result = await api.createTicket({ ...input, idempotencyKey: input.idempotencyKey ?? makeLocalId('tracker-create') });
      saveTicket(result.ticket);
      ticketCache(result.ticket.key).pending = false;
      for (const [key, query] of watchQueries) {
        if (listListeners.has(key)) void loadList(query, { force: true }).catch(() => undefined);
      }
      for (const key of listCaches.keys()) if (!watchQueries.has(key)) loadedLists.delete(key);
      notify();
      return cloneTrackerData(result.ticket);
    } catch (caught) {
      const error = asTrackerError(caught);
      setReadonlyFrom(error);
      notify();
      throw error;
    }
  }

  async function updateTicket(key: string, patch: Omit<TrackerPatch, 'ifUpdatedSeq'>): Promise<TrackerTicket> {
    assertWritable();
    const current = await ensureCurrent(key);
    const state = ticketCache(key);
    const prior = cloneTrackerData(state);
    const optimistic = ticketWithPatch(current, patch, meta, now());
    updateCacheTicket(state, optimistic);
    state.pending = true;
    state.error = undefined;
    state.conflict = undefined;
    notify();
    if (!isOnline()) {
      enqueue(key, { kind: 'patch', value: cloneTrackerData(patch), baseSeq: current.updatedSeq });
      return cloneTrackerData(optimistic);
    }
    try {
      const result = await api.patchTicket(key, { ...patch, ifUpdatedSeq: current.updatedSeq });
      updateCacheTicket(state, result.ticket);
      saveTicket(result.ticket);
      state.pending = false;
      state.offlineQueued = false;
      state.error = undefined;
      notify();
      return cloneTrackerData(result.ticket);
    } catch (caught) {
      return handleMutationFailure(key, state, prior, asTrackerError(caught));
    }
  }

  async function transitionTicket(key: string, stateName: string): Promise<TrackerTicket> {
    assertWritable();
    const current = await ensureCurrent(key);
    const state = ticketCache(key);
    const prior = cloneTrackerData(state);
    const target = meta?.states.find((candidate) => candidate.id === stateName || candidate.key.toLowerCase() === stateName.toLowerCase() || candidate.name.toLowerCase() === stateName.toLowerCase());
    const optimistic = cloneTrackerData(current);
    if (target) optimistic.state = { id: target.id, key: target.key, name: target.name, category: target.category };
    state.ticket = optimistic;
    if (state.detail) state.detail = { ...state.detail, ticket: cloneTrackerData(optimistic) };
    state.pending = true;
    state.error = undefined;
    state.conflict = undefined;
    notify();
    if (!isOnline()) {
      enqueue(key, { kind: 'transition', value: stateName, baseSeq: current.updatedSeq });
      return cloneTrackerData(optimistic);
    }
    try {
      const result = await api.transitionTicket(key, stateName);
      updateCacheTicket(state, result.ticket);
      saveTicket(result.ticket);
      state.pending = false;
      state.offlineQueued = false;
      notify();
      return cloneTrackerData(result.ticket);
    } catch (caught) {
      return handleMutationFailure(key, state, prior, asTrackerError(caught));
    }
  }

  async function addComment(key: string, body: string, clientId = makeLocalId('tracker-comment')): Promise<TrackerComment> {
    assertWritable();
    const current = await ensureCurrent(key);
    const state = ticketCache(key);
    const prior = cloneTrackerData(state);
    const optimistic: TrackerComment = {
      id: `pending:${clientId}`, ticketKey: current.key,
      author: { userId: meta?.me.userId ?? null, name: meta?.members.find((member) => member.userId === meta?.me.userId)?.name ?? 'You' },
      body, clientId, createdAt: now(), editedAt: null,
    };
    if (!state.detail) state.detail = { ticket: cloneTrackerData(current), comments: [], events: [], subscribed: state.subscribed ?? false };
    state.detail.comments = [...state.detail.comments, optimistic];
    state.pending = true;
    state.error = undefined;
    notify();
    if (!isOnline()) {
      enqueue(key, { kind: 'comment', value: { body, clientId, localId: optimistic.id }, baseSeq: current.updatedSeq });
      return cloneTrackerData(optimistic);
    }
    try {
      const result = await api.addComment(key, { body, clientId });
      updateCacheTicket(state, result.ticket);
      if (state.detail) {
        state.detail.comments = state.detail.comments.filter((comment) => comment.clientId !== clientId);
        state.detail.comments.push(cloneTrackerData(result.comment));
      }
      saveTicket(result.ticket);
      state.pending = false;
      state.offlineQueued = false;
      notify();
      return cloneTrackerData(result.comment);
    } catch (caught) {
      const error = asTrackerError(caught);
      if (state.detail) state.detail.comments = state.detail.comments.filter((comment) => comment.clientId !== clientId);
      return handleMutationFailure(key, state, prior, error);
    }
  }

  async function setSubscription(key: string, subscribed: boolean): Promise<boolean> {
    assertWritable();
    const state = ticketCache(key);
    const prior = cloneTrackerData(state);
    state.subscribed = subscribed;
    if (state.detail) state.detail.subscribed = subscribed;
    state.pending = true;
    state.error = undefined;
    notify();
    if (!isOnline()) {
      enqueue(key, { kind: 'subscription', value: subscribed, baseSeq: state.ticket?.updatedSeq ?? 0 });
      return subscribed;
    }
    try {
      const result = await api.setSubscription(key, subscribed);
      state.subscribed = result.subscribed;
      if (state.detail) state.detail.subscribed = result.subscribed;
      state.pending = false;
      notify();
      return result.subscribed;
    } catch (caught) {
      return handleMutationFailure(key, state, prior, asTrackerError(caught));
    }
  }

  async function bulk(keys: string[], patch: TrackerBulkPatch): Promise<TrackerUndoBatch> {
    assertWritable();
    const uniqueKeys = [...new Set(keys.map((key) => cacheTicketKey(key)))];
    const tickets = await Promise.all(uniqueKeys.map((key) => ensureCurrent(key)));
    const prior = new Map(uniqueKeys.map((key) => [key, cloneTrackerData(ticketCache(key))]));
    const before: TrackerBulkResult['before'] = {};
    uniqueKeys.forEach((key, index) => {
      before[key] = { patch: patchValuesBefore(tickets[index], patch), updatedSeq: tickets[index].updatedSeq };
      const state = ticketCache(key);
      updateCacheTicket(state, ticketWithPatch(tickets[index], patch, meta, now()));
      state.pending = true;
      state.error = undefined;
    });
    notify();
    if (!isOnline()) {
      uniqueKeys.forEach((key, index) => enqueue(key, { kind: 'patch', value: cloneTrackerData(patch), baseSeq: tickets[index].updatedSeq }));
      return { batchId: makeLocalId('offline-batch'), before };
    }
    try {
      const result = await api.bulkTickets({ keys: uniqueKeys, patch });
      for (const item of result.results) {
        const state = ticketCache(item.key);
        if (item.ok && item.ticket) {
          updateCacheTicket(state, item.ticket);
          saveTicket(item.ticket);
          state.pending = false;
          state.offlineQueued = false;
        } else {
          const old = prior.get(cacheTicketKey(item.key));
          if (old) { state.ticket = old.ticket; state.detail = old.detail; if (old.ticket) updateListRows(old.ticket); }
          state.pending = false;
          state.error = new TrackerError(isErrorCode(item.error) ? item.error : 'internal', String(item.error ?? 'Bulk update failed.'));
          setReadonlyFrom(state.error);
        }
      }
      notify();
      return { batchId: result.batchId, before: result.before };
    } catch (caught) {
      const error = asTrackerError(caught);
      for (const key of uniqueKeys) {
        const state = ticketCache(key);
        const old = prior.get(key);
        if (old) {
          state.ticket = old.ticket; state.detail = old.detail; state.subscribed = old.subscribed;
          if (old.ticket) updateListRows(old.ticket);
        }
        state.pending = false;
        state.error = error;
      }
      if (error.code === 'conflict' && error.current) {
        const state = ticketCache(error.current.key);
        updateCacheTicket(state, error.current);
        state.conflict = cloneTrackerData(error.current);
      }
      setReadonlyFrom(error);
      notify();
      throw error;
    }
  }

  async function undo(batch: TrackerUndoBatch): Promise<TrackerBulkResult> {
    const entries = Object.entries(batch.before);
    const beforeRedo: TrackerBulkResult['before'] = {};
    const results = await Promise.all(entries.map(async ([key, before]) => {
      try {
        const current = await ensureCurrent(key);
        beforeRedo[key] = { patch: patchValuesBefore(current, before.patch), updatedSeq: current.updatedSeq };
        const updated = await updateTicket(key, before.patch);
        return { key, ok: true, ticket: updated };
      } catch (caught) {
        const error = asTrackerError(caught);
        const state = ticketCache(key);
        setReadonlyFrom(error);
        if (error.code === 'conflict') {
          let current = error.current;
          if (!current) { try { current = (await api.getTicket(key)).ticket; } catch { current = undefined; } }
          if (current) { updateCacheTicket(state, current); state.conflict = current; }
        }
        state.pending = false;
        state.error = error;
        return { key, ok: false, error: error.code };
      }
    }));
    notify();
    return { batchId: `undo:${batch.batchId}`, results, before: beforeRedo };
  }

  async function replayOfflineQueue(): Promise<void> {
    if (!isOnline() || replaying || destroyed) return;
    replaying = true;
    try {
      for (const [key, queue] of offlineQueue) {
        if (blockedQueue.has(key) || queue.length === 0 || !isOnline()) continue;
        const state = ticketCache(key);
        let current = state.ticket;
        if (!current) {
          try { current = (await api.getTicket(key)).ticket; }
          catch (caught) { state.error = asTrackerError(caught); continue; }
        }
        let baseSeq = queue[0].baseSeq;
        let stop = false;
        while (queue.length > 0) {
          const edit = queue[0];
          if (!isOnline()) { stop = true; break; }
          try {
            let updated: TrackerTicket | undefined;
            if (edit.kind === 'patch') {
              updated = (await api.patchTicket(key, { ...(edit.value as TrackerBulkPatch), ifUpdatedSeq: baseSeq })).ticket;
            } else if (edit.kind === 'transition') {
              const fresh = (await api.getTicket(key)).ticket;
              if (fresh.updatedSeq !== baseSeq) throw new TrackerError('conflict', 'The ticket changed while this edit was offline.', { current: fresh });
              updated = (await api.transitionTicket(key, String(edit.value))).ticket;
            } else if (edit.kind === 'comment') {
              const comment = edit.value as { body: string; clientId: string; localId: string };
              const result = await api.addComment(key, { body: comment.body, clientId: comment.clientId });
              updated = result.ticket;
              if (state.detail) {
                state.detail.comments = state.detail.comments.filter((entry) => entry.id !== comment.localId && entry.clientId !== comment.clientId);
                state.detail.comments.push(cloneTrackerData(result.comment));
              }
            } else {
              state.subscribed = (await api.setSubscription(key, Boolean(edit.value))).subscribed;
              if (state.detail) state.detail.subscribed = state.subscribed;
            }
            if (updated) {
              current = updated;
              baseSeq = updated.updatedSeq;
              updateCacheTicket(state, updated);
              saveTicket(updated);
            }
            queue.shift();
            notify();
          } catch (caught) {
            const error = asTrackerError(caught);
            setReadonlyFrom(error);
            state.error = error;
            state.pending = false;
            if (error.code === 'conflict') {
              let latest = error.current;
              if (!latest) { try { latest = (await api.getTicket(key)).ticket; } catch { latest = undefined; } }
              if (latest) { updateCacheTicket(state, latest); state.conflict = cloneTrackerData(latest); saveTicket(latest); }
              blockedQueue.add(key);
            }
            if (error.code !== 'network' && error.code !== 'offline') blockedQueue.add(key);
            stop = true;
            break;
          }
        }
        if (!stop && queue.length === 0) {
          offlineQueue.delete(key);
          state.pending = false;
          state.offlineQueued = false;
          state.error = undefined;
        } else {
          offlineQueue.set(key, queue);
          state.offlineQueued = queue.length > 0;
        }
        notify();
      }
    } finally {
      replaying = false;
    }
  }

  async function addRelation(key: string, relation: { kind: TrackerRelationKind; key: string }): Promise<TrackerTicket> {
    assertWritable();
    try {
      const result = await api.addRelation(key, relation);
      saveTicket(result.ticket);
      const state = ticketCache(key);
      updateCacheTicket(state, result.ticket);
      notify();
      return cloneTrackerData(result.ticket);
    } catch (caught) {
      const error = asTrackerError(caught); setReadonlyFrom(error); throw error;
    }
  }

  async function removeRelation(key: string, relation: { kind: TrackerRelationKind; key: string }): Promise<TrackerTicket> {
    assertWritable();
    try {
      const result = await api.removeRelation(key, relation);
      saveTicket(result.ticket);
      const state = ticketCache(key);
      updateCacheTicket(state, result.ticket);
      notify();
      return cloneTrackerData(result.ticket);
    } catch (caught) {
      const error = asTrackerError(caught); setReadonlyFrom(error); throw error;
    }
  }

  function watchTicket(key: string, listener: (state: TrackerTicketCache) => void): () => void {
    const normalized = cacheTicketKey(key);
    const listeners = ticketListeners.get(normalized) ?? new Set();
    listeners.add(listener);
    ticketListeners.set(normalized, listeners);
    listener(cloneTrackerData(ticketCache(normalized)));
    if (!ticketCache(normalized).detail) void loadTicket(key).catch(() => undefined);
    startWatching();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) ticketListeners.delete(normalized);
      if (watchedCount() === 0) stopPoll();
    };
  }

  function watchList(query: TrackerListQuery, listener: (state: TrackerListCache) => void): () => void {
    const key = normalizeListQuery(query);
    const listeners = listListeners.get(key) ?? new Set();
    listeners.add(listener);
    listListeners.set(key, listeners);
    watchQueries.set(key, cloneTrackerData(query));
    listener(cloneTrackerData(listCache(query)));
    if (!loadedLists.has(key)) void loadList(query).catch(() => undefined);
    startWatching();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) { listListeners.delete(key); watchQueries.delete(key); }
      if (watchedCount() === 0) stopPoll();
    };
  }

  const onlineListener = () => { void replayOfflineQueue(); };
  if (typeof window !== 'undefined') window.addEventListener('online', onlineListener);

  return {
    subscribe(listener) { generalListeners.add(listener); return () => generalListeners.delete(listener); },
    snapshot,
    loadMeta,
    loadList,
    loadMore,
    list(query = {}) { return cloneTrackerData(listCache(query)); },
    watchList,
    ticket(key) { return cloneTrackerData(ticketCache(key)); },
    loadTicket,
    watchTicket,
    createTicket,
    updateTicket,
    transitionTicket,
    addComment,
    setSubscription,
    bulk,
    undo,
    replayOfflineQueue,
    addRelation,
    removeRelation,
    destroy() {
      destroyed = true;
      stopPoll();
      if (typeof window !== 'undefined') window.removeEventListener('online', onlineListener);
      generalListeners.clear(); ticketListeners.clear(); listListeners.clear(); watchQueries.clear();
      offlineQueue.clear(); blockedQueue.clear();
    },
  };
}

export { createMockTrackerApi } from './tracker-mock';
