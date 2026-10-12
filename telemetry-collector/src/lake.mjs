import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { lakeLock, listSpool } from './spool.mjs';
import { withLock } from './lock.mjs';

export const STREAMS = ['reports_hourly', 'errors', 'events', 'status', 'alerts'];

/** The one column set of every spool row and every Parquet file (stream, dt and workspace become the partition path). */
export const LAKE_COLUMNS = {
  stream: 'VARCHAR', dt: 'VARCHAR', workspace: 'VARCHAR', hour: 'BIGINT', schema: 'INTEGER', received_at: 'BIGINT',
  name: 'VARCHAR', kind: 'VARCHAR', labels: 'VARCHAR', value: 'DOUBLE', count: 'BIGINT', sum: 'DOUBLE', buckets: 'VARCHAR',
  status: 'INTEGER', fingerprint: 'VARCHAR', top_frame: 'VARCHAR', data: 'VARCHAR',
};
const COLUMN_SQL = `{${Object.entries(LAKE_COLUMNS).map(([k, v]) => `'${k}': '${v}'`).join(', ')}}`;
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/u;

/** Run SQL through the DuckDB CLI. Output is JSON (`-json`) unless `raw`. */
export function runDuckdb(config, sql, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-batch', ...(raw ? [] : ['-json'])];
    const child = execFile(config.duckdb, args, { maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 }, (error, stdout, stderr) => {
      if (error) return reject(Object.assign(new Error(`duckdb failed: ${String(stderr).slice(0, 400) || error.message}`), { code: error.code }));
      if (raw) return resolve(stdout);
      const text = stdout.trim();
      try { resolve(text ? JSON.parse(text) : []); } catch { resolve(text); }
    });
    child.stdin.end(`SET memory_limit=${quote(config.duckdbMemory)};\nSET threads=1;\n${sql}\n`);
  });
}

function moveTree(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      moveTree(source, target);
    } else {
      fs.renameSync(source, target);
    }
  }
}

function countSpoolRows(file) {
  let n = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) if (line.trim()) n += 1;
  return n;
}

/**
 * Compact every closed day's spool file (a day before `today`) into Parquet partitions
 * `stream=/dt=/workspace=/part-<day>-N.parquet` (zstd). The files are written to a staging directory first, the row count is
 * compared with the spool, and only then moved into place and the spool file deleted. A done-marker makes a re-run safe.
 */
export async function compact(config, { today = new Date().toISOString().slice(0, 10), day = null } = {}) {
  const results = [];
  await withLock(lakeLock(config.lakeDir), async () => {
    const markers = path.join(config.lakeDir, '_compacted');
    fs.mkdirSync(markers, { recursive: true });
    for (const spool of listSpool(config.lakeDir)) {
      if (day ? spool.day !== day : spool.day >= today) continue;
      const marker = path.join(markers, `${spool.day}.done`);
      if (fs.existsSync(marker)) { fs.rmSync(spool.file); results.push({ day: spool.day, rows: 0, status: 'already_done' }); continue; }
      const rows = countSpoolRows(spool.file);
      if (rows === 0) { fs.rmSync(spool.file); results.push({ day: spool.day, rows: 0, status: 'empty' }); continue; }
      const staging = path.join(config.lakeDir, '.staging', `${spool.day}-${process.pid}`);
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      try {
        await runDuckdb(config, `COPY (SELECT stream, dt, COALESCE(workspace, '_none') AS workspace, hour, schema, received_at, name, kind, labels, value, count, sum, buckets, status, fingerprint, top_frame, data
  FROM read_json(${quote(spool.file)}, format='newline_delimited', columns=${COLUMN_SQL}, ignore_errors=true))
  TO ${quote(staging)} (FORMAT PARQUET, COMPRESSION zstd, PARTITION_BY (stream, dt, workspace), FILENAME_PATTERN ${quote(`part-${spool.day}-{i}`)});`, { raw: true });
        const counted = await runDuckdb(config, `SELECT count(*) AS n FROM read_parquet(${quote(`${staging}/**/*.parquet`)}, hive_partitioning=true);`);
        const written = Number(counted[0]?.n);
        if (written !== rows) throw new Error(`row count mismatch for ${spool.day}: spool ${rows}, parquet ${written}`);
        moveTree(staging, config.lakeDir);
        fs.writeFileSync(marker, `${rows}\n`);
        fs.rmSync(spool.file);
        results.push({ day: spool.day, rows, status: 'compacted' });
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    }
  }, { timeoutMs: 60_000, staleMs: 30 * 60 * 1000 });
  return results;
}

/** Remove partitions older than each stream's retention. Returns removed `dt` directory paths. */
export async function applyRetention(config, { now = Date.now() } = {}) {
  const removed = [];
  await withLock(lakeLock(config.lakeDir), () => {
    for (const stream of STREAMS) {
      const days = config.retentionDays[stream];
      const streamDir = path.join(config.lakeDir, `stream=${stream}`);
      if (!days || !fs.existsSync(streamDir)) continue;
      const cutoff = new Date(now - days * config.dayMs).toISOString().slice(0, 10);
      for (const name of fs.readdirSync(streamDir)) {
        const m = /^dt=(\d{4}-\d{2}-\d{2})$/u.exec(name);
        if (m && m[1] < cutoff) {
          fs.rmSync(path.join(streamDir, name), { recursive: true, force: true });
          removed.push(`stream=${stream}/${name}`);
        }
      }
    }
  }, { timeoutMs: 60_000, staleMs: 30 * 60 * 1000 });
  return removed;
}

/** Remove one workspace's partition directories from every stream. Caller holds the lake lock. */
export function removeWorkspacePartitions(lakeDir, workspace) {
  const removed = [];
  if (!fs.existsSync(lakeDir)) return removed;
  for (const stream of fs.readdirSync(lakeDir)) {
    if (!stream.startsWith('stream=')) continue;
    const streamDir = path.join(lakeDir, stream);
    for (const dt of fs.readdirSync(streamDir)) {
      const target = path.join(streamDir, dt, `workspace=${workspace}`);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
        removed.push(`${stream}/${dt}`);
        try { fs.rmdirSync(path.join(streamDir, dt)); } catch { /* not empty */ }
      }
    }
  }
  return removed;
}

/** SQL that defines one view per stream over the Parquet files plus today's not yet compacted spool. */
export function viewsSql(lakeDir) {
  const spool = listSpool(lakeDir);
  const columns = Object.keys(LAKE_COLUMNS).join(', ');
  const parts = [];
  for (const stream of STREAMS) {
    const sources = [];
    const dir = path.join(lakeDir, `stream=${stream}`);
    if (fs.existsSync(dir)) {
      sources.push(`SELECT ${columns} FROM read_parquet(${quote(`${dir}/dt=*/workspace=*/*.parquet`)}, hive_partitioning=true, hive_types_autocast=false, union_by_name=true)`);
    }
    if (spool.length) {
      sources.push(`SELECT ${columns} FROM read_json(${quote(path.join(lakeDir, 'spool', 'ingest-*.ndjson'))}, format='newline_delimited', columns=${COLUMN_SQL}, ignore_errors=true) WHERE stream = ${quote(stream)}`);
    }
    parts.push(`CREATE OR REPLACE VIEW ${stream} AS ${sources.length ? sources.join(' UNION ALL BY NAME ') : `SELECT ${Object.entries(LAKE_COLUMNS).map(([k, v]) => `NULL::${v} AS ${k}`).join(', ')} WHERE false`};`);
  }
  return parts.join('\n');
}

export function validDay(value) {
  return DAY_RE.test(value);
}
