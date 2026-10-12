export const MAIL_UNAVAILABLE_MESSAGE = 'We could not send the sign-in email right now. Try again in a few minutes, or ask your teacher to check the workspace.';
export const MAIL_REFUSAL_WINDOW_MS = 10 * 60 * 1000;

const RELAY_REASON_CODES = new Set(['relay_rate_limited', 'relay_error']);

/** Classify only service responses as refusals; transports and connection failures stay a network error. */
export function mailFailureDetails(error) {
  const candidate = error && typeof error === 'object' ? error : {};
  const reasonCode = candidate.reasonCode;
  if (typeof reasonCode === 'string' && RELAY_REASON_CODES.has(reasonCode)) {
    return { reason: reasonCode, refused: true };
  }
  const status = candidate.status ?? candidate.statusCode ?? candidate.responseCode;
  if (status === 429) return { reason: 'relay_rate_limited', refused: true };
  if (typeof status === 'number' && status >= 300 && status < 600) return { reason: 'relay_error', refused: true };
  return { reason: 'network', refused: false };
}

/** The status for every auth request is the same while a service refusal is recent. */
export function authMailUnavailable(health) {
  return health?.refusedRecently > 0
    ? { status: 503, code: 'mail_unavailable', message: MAIL_UNAVAILABLE_MESSAGE }
    : null;
}

/** Per-process state for the most recent mail failure, cleared as soon as any send succeeds. */
export function createMailHealth({ now = Date.now, windowMs = MAIL_REFUSAL_WINDOW_MS } = {}) {
  let lastFailure = null;

  function recordFailure(reason, refused) {
    lastFailure = { at: now(), reason, refused: Boolean(refused) };
  }

  function clear() {
    lastFailure = null;
  }

  function status() {
    const age = lastFailure ? now() - lastFailure.at : Infinity;
    const recent = age >= 0 && age < windowMs;
    return {
      refusedRecently: recent && lastFailure.refused ? 1 : 0,
      reason: recent ? lastFailure.reason : null,
    };
  }

  return { recordFailure, clear, status };
}
