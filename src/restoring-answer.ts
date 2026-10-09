// Whether an answer of the server says a restore has taken the workspace over (docs/backups.md, "In the app"). It lives
// outside src/ui so the shared api client can use it without importing from the interface.

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * True for exactly one answer: HTTP 503 with a JSON body whose error is `restoring`. A 503 from anything else (the AI
 * routes, a gateway with an HTML page, another JSON error) is not a restore.
 */
export function isRestoringAnswer(status: number, data: unknown): boolean {
  return status === 503 && isRecord(data) && data.error === 'restoring';
}
