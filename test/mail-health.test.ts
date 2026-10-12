import { describe, expect, it } from 'vitest';
import { authMailUnavailable, createMailHealth, mailFailureDetails, MAIL_UNAVAILABLE_MESSAGE, MAIL_REFUSAL_WINDOW_MS } from '../server/mail-health.mjs';

describe('mail health', () => {
  it('starts clear, records only recent service refusals, and clears after success', () => {
    let now = 1_000;
    const health = createMailHealth({ now: () => now });
    expect(health.status()).toEqual({ refusedRecently: 0, reason: null });

    health.recordFailure('relay_rate_limited', true);
    expect(health.status()).toEqual({ refusedRecently: 1, reason: 'relay_rate_limited' });
    expect(authMailUnavailable(health.status())).toEqual({
      status: 503,
      code: 'mail_unavailable',
      message: MAIL_UNAVAILABLE_MESSAGE,
    });

    now += MAIL_REFUSAL_WINDOW_MS - 1;
    expect(health.status().refusedRecently).toBe(1);
    now += 1;
    expect(health.status()).toEqual({ refusedRecently: 0, reason: null });
    expect(authMailUnavailable(health.status())).toBeNull();

    health.recordFailure('network', false);
    expect(health.status()).toEqual({ refusedRecently: 0, reason: 'network' });
    health.recordFailure('relay_error', true);
    health.clear();
    expect(health.status()).toEqual({ refusedRecently: 0, reason: null });
  });

  it('classifies HTTP relay refusals separately from network errors', () => {
    expect(mailFailureDetails({ status: 429 })).toEqual({ reason: 'relay_rate_limited', refused: true });
    expect(mailFailureDetails({ reasonCode: 'relay_error', status: 503 })).toEqual({ reason: 'relay_error', refused: true });
    expect(mailFailureDetails(new Error('fetch failed'))).toEqual({ reason: 'network', refused: false });
  });

  it('leaves the request that starts a refusal on its original answer, then exposes the shared state', () => {
    const health = createMailHealth({ now: () => 1_000 });
    const answerAtRequestStart = health.status();

    health.recordFailure('relay_error', true);

    expect(authMailUnavailable(answerAtRequestStart)).toBeNull();
    expect(authMailUnavailable(health.status())).toEqual({
      status: 503,
      code: 'mail_unavailable',
      message: MAIL_UNAVAILABLE_MESSAGE,
    });
  });
});
