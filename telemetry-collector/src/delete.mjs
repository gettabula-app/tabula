import fs from 'node:fs';
import path from 'node:path';
import { removeWorkspacePartitions } from './lake.mjs';
import { withLock } from './lock.mjs';
import { WORKSPACE_RE, revokeTokens } from './registry.mjs';
import { lakeLock, purgeSpool } from './spool.mjs';
import { forgetWorkspaceHours, markDeleting, removeAllowed, updateMarker } from './state.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(fetchImpl, url, init, timeoutMs) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
}

/**
 * Delete everything held for one workspace id: VictoriaMetrics series, Loki streams, lake partitions and spool rows.
 * Order: (1) write the deletion marker, which makes every collector refuse new writes for that id and makes the sink retry
 * queues drop that id's items; (2) wait `deleteWaitMs` (longer than a sink timeout) for requests already in flight;
 * (3) revoke tokens (unless `keepTokens`) and purge every store. The marker stays after the purge, so a later report
 * cannot bring the data back; `workspace unblock` removes it. It also records that restic snapshots may still hold the data
 * (`backups: 'pending'`) until `deletion complete` is run after the backup erasure.
 * Every store is attempted; the result names each outcome, and a failed store makes `ok` false so the caller retries.
 * A ledger line (ids, time and outcomes, no content) is appended to the deletion log.
 */
export async function deleteWorkspace(config, workspace, { fetchImpl = fetch, now = Date.now(), keepTokens = false, log = null } = {}) {
  if (typeof workspace !== 'string' || !WORKSPACE_RE.test(workspace)) throw new Error('invalid workspace id');
  const selector = `{workspace="${workspace}"}`; // the id pattern excludes quotes and braces
  const result = { workspace, tokensRevoked: 0, victoriametrics: 'pending', loki: 'pending', lake: null, ok: false, backups: 'pending' };
  const { created } = markDeleting(config, workspace, now);
  if (created && config.deleteWaitMs > 0) await sleep(config.deleteWaitMs);
  removeAllowed(config, workspace);
  forgetWorkspaceHours(config, workspace);
  if (!keepTokens) result.tokensRevoked = revokeTokens(config.registryFile, { workspace, now });

  try {
    await call(fetchImpl, `${config.vmUrl}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(selector)}`, { method: 'POST' }, 30_000);
    result.victoriametrics = 'ok';
  } catch (error) {
    result.victoriametrics = `failed: ${error.message}`;
  }

  try {
    const start = Math.floor((now - 800 * config.dayMs) / 1000);
    const end = Math.floor(now / 1000); // Loki refuses a delete whose end lies in the future
    await call(fetchImpl, `${config.lokiUrl}/loki/api/v1/delete?query=${encodeURIComponent(selector)}&start=${start}&end=${end}`, { method: 'POST' }, 30_000);
    result.loki = 'ok';
  } catch (error) {
    result.loki = `failed: ${error.message}`;
  }

  try {
    result.lake = await withLock(lakeLock(config.lakeDir), async () => {
      const partitions = removeWorkspacePartitions(config.lakeDir, workspace);
      const spoolRows = await purgeSpool(config.lakeDir, workspace);
      return { partitionsRemoved: partitions.length, spoolRowsRemoved: spoolRows };
    }, { timeoutMs: 10 * 60 * 1000, staleMs: 30 * 60 * 1000 });
  } catch (error) {
    result.lake = `failed: ${error.message}`;
  }

  result.ok = result.victoriametrics === 'ok' && result.loki === 'ok' && typeof result.lake === 'object' && result.lake !== null;
  if (result.ok) updateMarker(config, workspace, { storesPurgedAt: now });
  fs.mkdirSync(path.dirname(config.deletionLog), { recursive: true });
  fs.appendFileSync(config.deletionLog, `${JSON.stringify({ at: new Date(now).toISOString(), ...result })}\n`, { mode: 0o640 });
  log?.info('workspace_deleted', { workspace, ok: result.ok });
  return result;
}
