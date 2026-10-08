import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { IconError, classifyIconFailure, collectionIcons, failureMessage, failureOf, iconLoader, autoRetryDelay, resetIconCaches, searchIcons, type IconFailure } from '../src/icons';

describe('classifyIconFailure', () => {
  const online = true;

  it('reports offline whenever the browser is offline, whatever the status or error', () => {
    expect(classifyIconFailure({ status: 429, online: false })).toEqual({ kind: 'offline' });
    expect(classifyIconFailure({ error: new TypeError('Failed to fetch'), online: false })).toEqual({ kind: 'offline' });
  });

  it('reports a network error while online as unreachable, the shape of Iconify 429s without CORS', () => {
    expect(classifyIconFailure({ error: new TypeError('Failed to fetch'), online })).toEqual({ kind: 'unreachable' });
    expect(classifyIconFailure({ online })).toEqual({ kind: 'other' });
  });

  it('reads Retry-After in seconds on a 429', () => {
    expect(classifyIconFailure({ status: 429, retryAfter: '7', online })).toEqual({ kind: 'rate-limited', retryAfter: 7 });
    expect(classifyIconFailure({ status: 429, retryAfter: ' 120 ', online })).toEqual({ kind: 'rate-limited', retryAfter: 120 });
  });

  it('reads Retry-After as an HTTP date relative to now', () => {
    const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT') - 30_000;
    expect(classifyIconFailure({ status: 429, retryAfter: 'Wed, 21 Oct 2015 07:28:00 GMT', online }, now)).toEqual({ kind: 'rate-limited', retryAfter: 30 });
  });

  it('treats a Retry-After date in the past as zero', () => {
    const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT') + 5_000;
    expect(classifyIconFailure({ status: 429, retryAfter: 'Wed, 21 Oct 2015 07:28:00 GMT', online }, now)).toEqual({ kind: 'rate-limited', retryAfter: 0 });
  });

  it('leaves the delay out when Retry-After is missing or unreadable', () => {
    expect(classifyIconFailure({ status: 429, retryAfter: null, online })).toEqual({ kind: 'rate-limited' });
    expect(classifyIconFailure({ status: 429, retryAfter: 'soon', online })).toEqual({ kind: 'rate-limited' });
    expect(classifyIconFailure({ status: 429, online })).toEqual({ kind: 'rate-limited' });
  });

  it('reports 5xx responses as a server error', () => {
    for (const status of [500, 502, 503, 599]) {
      expect(classifyIconFailure({ status, online })).toEqual({ kind: 'server' });
    }
  });

  it('reports other statuses, timeouts and parse errors as other', () => {
    expect(classifyIconFailure({ status: 404, online })).toEqual({ kind: 'other' });
    expect(classifyIconFailure({ status: 400, online })).toEqual({ kind: 'other' });
    expect(classifyIconFailure({ error: new DOMException('The operation was aborted.', 'AbortError'), online })).toEqual({ kind: 'other' });
    expect(classifyIconFailure({ error: new SyntaxError('Unexpected token <'), online })).toEqual({ kind: 'other' });
  });
});

describe('failureOf', () => {
  it('returns the failure an IconError carries', () => {
    expect(failureOf(new IconError({ kind: 'rate-limited', retryAfter: 3 }))).toEqual({ kind: 'rate-limited', retryAfter: 3 });
  });

  it('classifies other errors by the browser state', () => {
    expect(failureOf(new TypeError('Failed to fetch'))).toEqual({ kind: 'unreachable' });
    expect(failureOf(new Error('Icon x not found'))).toEqual({ kind: 'other' });
  });
});

describe('failureMessage', () => {
  it('gives the offline, busy and other messages, mentioning seconds only when Retry-After is known', () => {
    expect(failureMessage({ kind: 'offline' })).toBe("You're offline. Icons load again when you reconnect.");
    expect(failureMessage({ kind: 'rate-limited', retryAfter: 30 })).toBe('The icon service is busy. Try again in 30 seconds.');
    expect(failureMessage({ kind: 'rate-limited', retryAfter: 1 })).toBe('The icon service is busy. Try again in 1 second.');
    expect(failureMessage({ kind: 'rate-limited' })).toBe('The icon service is busy. Try again in a moment.');
    expect(failureMessage({ kind: 'unreachable' })).toBe('The icon service is not responding right now. Trying again shortly.');
    expect(failureMessage({ kind: 'server' })).toBe('Icons could not be loaded.');
    expect(failureMessage({ kind: 'other' })).toBe('Icons could not be loaded.');
  });
});

describe('autoRetryDelay', () => {
  it('waits for Retry-After, capped at 60 seconds', () => {
    expect(autoRetryDelay(12)).toBe(12_000);
    expect(autoRetryDelay(3600)).toBe(60_000);
  });

  it('waits 10 seconds when Retry-After is unknown', () => {
    expect(autoRetryDelay(undefined)).toBe(10_000);
  });
});

describe('iconLoader', () => {
  let query: Mock<(signal: AbortSignal) => Promise<string[]>>;
  let view: { loading: Mock<(on: boolean) => void>; results: Mock<(names: string[]) => void>; failed: Mock<(f: IconFailure, retry: () => void, busy: boolean) => void> };
  let target: EventTarget;
  let stop: AbortController;

  const offline = () => Promise.reject(new IconError({ kind: 'offline' }));
  const limited = (retryAfter?: number) => Promise.reject(new IconError({ kind: 'rate-limited', retryAfter }));
  const settle = () => vi.advanceTimersByTimeAsync(0);
  const start = () => iconLoader(query, view, stop.signal, target);
  const lastFailure = (): IconFailure => view.failed.mock.calls.at(-1)![0];

  beforeEach(() => {
    vi.useFakeTimers();
    query = vi.fn<(signal: AbortSignal) => Promise<string[]>>();
    view = { loading: vi.fn<(on: boolean) => void>(), results: vi.fn<(names: string[]) => void>(), failed: vi.fn<(f: IconFailure, retry: () => void, busy: boolean) => void>() };
    target = new EventTarget();
    stop = new AbortController();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports results and no failure after a successful load', async () => {
    query.mockResolvedValueOnce(['lucide:star']);
    start().reload();
    await settle();
    expect(view.results).toHaveBeenCalledWith(['lucide:star']);
    expect(view.failed).not.toHaveBeenCalled();
    expect(view.loading).toHaveBeenLastCalledWith(false);
  });

  it('shows the classified failure with an idle Retry button', async () => {
    query.mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')));
    start().reload();
    await settle();
    expect(view.failed).toHaveBeenCalledWith({ kind: 'unreachable' }, expect.any(Function), false);
  });

  it('runs again once when the browser comes back online', async () => {
    query.mockImplementationOnce(offline).mockResolvedValueOnce(['lucide:star']);
    start().reload();
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(query).toHaveBeenCalledTimes(1);

    target.dispatchEvent(new Event('online'));
    await settle();
    expect(query).toHaveBeenCalledTimes(2);
    expect(view.results).toHaveBeenCalledWith(['lucide:star']);
  });

  it('retries a rate limit once, after Retry-After', async () => {
    query.mockImplementationOnce(() => limited(5)).mockImplementationOnce(() => limited(5));
    start().reload();
    await settle();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(query).toHaveBeenCalledTimes(2);
    expect(lastFailure()).toEqual({ kind: 'rate-limited', retryAfter: 5 });
  });

  it('retries an unreachable service once after 10 seconds', async () => {
    query
      .mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')))
      .mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')));
    start().reload();
    await settle();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(query).toHaveBeenCalledTimes(2);
    expect(lastFailure()).toEqual({ kind: 'unreachable' });
  });

  it('caps the automatic rate-limit wait at 60 seconds', async () => {
    query.mockImplementationOnce(() => limited(600)).mockResolvedValueOnce(['a:b']);
    start().reload();
    await settle();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('waits 10 seconds before the automatic retry when Retry-After is unknown', async () => {
    query.mockImplementationOnce(() => limited()).mockResolvedValueOnce(['a:b']);
    start().reload();
    await settle();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(view.results).toHaveBeenCalledWith(['a:b']);
  });

  it('shows the retry as busy while it is in flight', async () => {
    let finish!: (names: string[]) => void;
    query.mockImplementationOnce(() => limited(2)).mockImplementationOnce(() => new Promise<string[]>((resolve) => { finish = resolve; }));
    start().reload();
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(view.failed).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'rate-limited' }), expect.any(Function), true);

    finish(['a:b']);
    await settle();
    expect(view.results).toHaveBeenCalledWith(['a:b']);
  });

  it('a manual retry starts a fresh automatic retry', async () => {
    query
      .mockImplementationOnce(() => limited(1))
      .mockImplementationOnce(() => limited(1))
      .mockImplementationOnce(() => limited(1))
      .mockImplementationOnce(() => limited(1));
    const loader = start();
    loader.reload();
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(query).toHaveBeenCalledTimes(2);

    loader.reload();
    await settle();
    expect(query).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('does not retry on its own for server or other failures', async () => {
    query.mockImplementationOnce(() => Promise.reject(new IconError({ kind: 'server' }))).mockResolvedValueOnce(['a:b']);
    start().reload();
    await settle();
    expect(view.failed).toHaveBeenCalledWith({ kind: 'server' }, expect.any(Function), false);
    await vi.advanceTimersByTimeAsync(120_000);
    target.dispatchEvent(new Event('online'));
    await settle();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('drops the armed retries once a load succeeds', async () => {
    query.mockImplementationOnce(offline).mockResolvedValueOnce(['a:b']);
    const loader = start();
    loader.reload();
    await settle();
    loader.reload();
    await settle();
    expect(view.results).toHaveBeenCalledWith(['a:b']);

    target.dispatchEvent(new Event('online'));
    await settle();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('clears the rate-limit timer and the online listener when the drawer closes', async () => {
    query.mockImplementationOnce(() => limited(5));
    start().reload();
    await settle();
    stop.abort();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(query).toHaveBeenCalledTimes(1);

    const other = new AbortController();
    query.mockImplementationOnce(offline);
    iconLoader(query, view, other.signal, target).reload();
    await settle();
    other.abort();
    target.dispatchEvent(new Event('online'));
    await settle();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('drops a load that finishes after the drawer closed, and aborts its request', async () => {
    let finish!: (names: string[]) => void;
    const seen: AbortSignal[] = [];
    query.mockImplementationOnce((s) => {
      seen.push(s);
      return new Promise<string[]>((resolve) => { finish = resolve; });
    });
    start().reload();
    stop.abort();
    expect(seen[0].aborted).toBe(true);
    finish(['a:b']);
    await settle();
    expect(view.results).not.toHaveBeenCalled();
  });

  it('aborts the load in flight when a new one starts, and drops its late result', async () => {
    const seen: AbortSignal[] = [];
    let finishFirst!: (names: string[]) => void;
    query
      .mockImplementationOnce((s) => {
        seen.push(s);
        return new Promise<string[]>((resolve) => { finishFirst = resolve; });
      })
      .mockImplementationOnce((s) => {
        seen.push(s);
        return Promise.resolve(['new:one']);
      });
    const loader = start();
    loader.reload();
    loader.reload();
    await settle();
    expect(seen[0].aborted).toBe(true);
    expect(seen[1].aborted).toBe(false);
    finishFirst(['old:one']);
    await settle();
    expect(view.results).toHaveBeenCalledTimes(1);
    expect(view.results).toHaveBeenCalledWith(['new:one']);
  });

  it('shows the loading state as soon as a load starts', async () => {
    query.mockResolvedValueOnce(['a:b']);
    start().reload();
    expect(view.loading).toHaveBeenLastCalledWith(true);
    await settle();
    expect(view.loading).toHaveBeenLastCalledWith(false);
  });
});

describe('Iconify requests', () => {
  let fetchMock: Mock<(url: string, init: RequestInit) => Promise<Response>>;
  let apiBehaviour: (url: string, init: RequestInit) => Promise<Response>;
  const iconifyCalls = () => fetchMock.mock.calls.filter(([url]) => !url.startsWith('/icons/'));

  beforeEach(() => {
    resetIconCaches();
    apiBehaviour = () => Promise.reject(new Error('unset'));
    fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>((url, init) => (url === '/icons/manifest.json'
      ? Promise.resolve(new Response(JSON.stringify({ v: 1, sets: [] }), { status: 200 }))
      : apiBehaviour(url, init)));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('makes no request when the caller has already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(searchIcons('star', undefined, 96, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(searchIcons('star', 'fa', 96, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ends at the caller abort instead of failing over to the next host', async () => {
    apiBehaviour = (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    });
    const ctl = new AbortController();
    const pending = collectionIcons('fa', 160, ctl.signal);
    await vi.waitFor(() => expect(iconifyCalls()).toHaveLength(1));
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(iconifyCalls()).toHaveLength(1);
  });

  it('reports a network error on every host as unreachable', async () => {
    apiBehaviour = () => Promise.reject(new TypeError('Failed to fetch'));
    await expect(searchIcons('star', 'fa')).rejects.toMatchObject({ failure: { kind: 'unreachable' } });
    expect(iconifyCalls()).toHaveLength(3);
  });

  it('classifies a rate limit from the final host and fails over before that', async () => {
    apiBehaviour = async () => new Response('busy', { status: 429 });
    await expect(searchIcons('star', 'fa')).rejects.toMatchObject({ failure: { kind: 'rate-limited' } });
    expect(iconifyCalls()).toHaveLength(3);
  });
});
