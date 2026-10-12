// Persistent usage and retry records for MCP board writes (docs/mcp.md).

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const DAILY_RETENTION_DAYS = 8;
const REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;

export const MCP_USAGE_MIGRATION = `
  CREATE TABLE mcp_daily_usage (
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    day TEXT NOT NULL,
    writes INTEGER NOT NULL,
    PRIMARY KEY (actor_kind, actor_id, day)
  );
  CREATE TABLE mcp_requests (
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    request_id TEXT NOT NULL,
    args_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_kind, actor_id, tool, request_id)
  );
  CREATE INDEX mcp_requests_created_at ON mcp_requests(created_at);
`;

const validActor = (actor) => actor && (actor.kind === 'token' || actor.kind === 'grant')
  && typeof actor.id === 'string' && actor.id.length > 0;

/** `db` is the synchronous query kit owned by openDirectory. */
export function createMcpUsageStore({ get, run, transaction }) {
  let lastSweepAt = null;

  function assertActor(actor) {
    if (!validActor(actor)) throw new TypeError('MCP usage actor is invalid');
  }

  function addMcpWrites(actor, day, n) {
    assertActor(actor);
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new TypeError('MCP usage day is invalid');
    if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('MCP write count is invalid');
    if (n === 0) return mcpWritesToday(actor, day);
    run(
      `INSERT INTO mcp_daily_usage (actor_kind, actor_id, day, writes) VALUES (?, ?, ?, ?)
       ON CONFLICT (actor_kind, actor_id, day) DO UPDATE SET writes = writes + excluded.writes`,
      actor.kind,
      actor.id,
      day,
      n,
    );
    return mcpWritesToday(actor, day);
  }

  function mcpWritesToday(actor, day) {
    assertActor(actor);
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new TypeError('MCP usage day is invalid');
    return get('SELECT writes FROM mcp_daily_usage WHERE actor_kind = ? AND actor_id = ? AND day = ?', actor.kind, actor.id, day)?.writes ?? 0;
  }

  function getMcpRequest(actor, tool, id) {
    assertActor(actor);
    if (typeof tool !== 'string' || typeof id !== 'string') throw new TypeError('MCP request key is invalid');
    const row = get(
      `SELECT args_hash, result_json, created_at FROM mcp_requests
        WHERE actor_kind = ? AND actor_id = ? AND tool = ? AND request_id = ?`,
      actor.kind,
      actor.id,
      tool,
      id,
    );
    return row ? { argsHash: row.args_hash, resultJson: row.result_json, createdAt: row.created_at } : null;
  }

  function putMcpRequest(actor, tool, id, argsHash, resultJson, createdAt) {
    assertActor(actor);
    if (typeof tool !== 'string' || typeof id !== 'string' || typeof argsHash !== 'string' || typeof resultJson !== 'string'
      || !Number.isSafeInteger(createdAt)) throw new TypeError('MCP request record is invalid');
    run(
      `INSERT INTO mcp_requests (actor_kind, actor_id, tool, request_id, args_hash, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (actor_kind, actor_id, tool, request_id) DO UPDATE SET
         args_hash = excluded.args_hash, result_json = excluded.result_json, created_at = excluded.created_at`,
      actor.kind,
      actor.id,
      tool,
      id,
      argsHash,
      resultJson,
      createdAt,
    );
  }

  function sweepMcp(now = Date.now()) {
    if (!Number.isSafeInteger(now)) throw new TypeError('MCP sweep time is invalid');
    if (lastSweepAt !== null && now - lastSweepAt < SWEEP_INTERVAL_MS) return { dailyUsage: 0, requests: 0 };
    const usageCutoff = new Date(now - DAILY_RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
    const requestCutoff = now - REQUEST_RETENTION_MS;
    const swept = transaction(() => ({
      dailyUsage: run('DELETE FROM mcp_daily_usage WHERE day < ?', usageCutoff),
      requests: run('DELETE FROM mcp_requests WHERE created_at < ?', requestCutoff),
    }));
    lastSweepAt = now;
    return swept;
  }

  return { addMcpWrites, mcpWritesToday, getMcpRequest, putMcpRequest, sweepMcp };
}
