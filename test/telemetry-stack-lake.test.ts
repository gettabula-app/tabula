import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../telemetry-collector/src/config.mjs';
import { compact, runDuckdb, viewsSql } from '../telemetry-collector/src/lake.mjs';
import { reportToRows } from '../telemetry-collector/src/map.mjs';
import { appendRows, listSpool } from '../telemetry-collector/src/spool.mjs';
import { validateReport } from '../telemetry-collector/src/validate.mjs';
import { CONTROL_PLANE_EVENTS, HOUR, WORKSPACE, validReport } from './telemetry-stack-fixtures';

function hasDuckdb(): boolean {
  try { execFileSync(process.env.DUCKDB_BIN || 'duckdb', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-lake-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(!hasDuckdb())('lake compaction with the DuckDB CLI', () => {
  it('compacts a closed day into zstd Parquet partitions, checks the row count, and the views read lake plus spool', async () => {
    const config = loadConfig({ TELEMETRY_DATA_DIR: dir, DUCKDB_MEMORY_LIMIT: '256MB' });
    const rowsFor = (id: string, hour: number) =>
      reportToRows((validateReport(validReport({ workspace: id, hour, events: CONTROL_PLANE_EVENTS }), { workspace: null, now: hour + 60_000, maxAgeMs: 1e12 }) as any).clean, hour + 60_000);
    const other = 'ws_other0123456';
    const yesterday = rowsFor(WORKSPACE, HOUR).concat(rowsFor(other, HOUR + 3600_000));
    await appendRows(config.lakeDir, yesterday, HOUR + 1000); // spool file of 2026-10-11
    const today = HOUR + 86_400_000;
    await appendRows(config.lakeDir, rowsFor(WORKSPACE, today), today + 1000); // spool file of 2026-10-12 (still open)

    const results = await compact(config, { today: '2026-10-12' });
    expect(results).toEqual([{ day: '2026-10-11', rows: yesterday.length, status: 'compacted' }]);
    expect(listSpool(config.lakeDir).map((s) => s.day)).toEqual(['2026-10-12']);
    for (const id of [WORKSPACE, other]) {
      const part = path.join(config.lakeDir, 'stream=errors', 'dt=2026-10-11', `workspace=${id}`);
      expect(fs.readdirSync(part)).toEqual(['part-2026-10-11-0.parquet']);
    }
    expect(fs.existsSync(path.join(config.lakeDir, '.staging', `2026-10-11-${process.pid}`))).toBe(false);

    // a re-run is a no-op
    expect(await compact(config, { today: '2026-10-12' })).toEqual([]);

    const rows = await runDuckdb(config, `${viewsSql(config.lakeDir)}
      SELECT workspace, count(*) AS n FROM reports_hourly GROUP BY workspace ORDER BY workspace;`) as any[];
    expect(rows.map((r) => r.workspace).sort()).toEqual([other, WORKSPACE].sort());
    const lake = await runDuckdb(config, `SELECT count(*) AS n FROM read_parquet('${config.lakeDir}/stream=errors/**/*.parquet')`) as any[];
    expect(Number(lake[0].n)).toBe(2);
    const events = await runDuckdb(config, `${viewsSql(config.lakeDir)} SELECT name, count(*) AS n FROM events GROUP BY name ORDER BY name;`) as any[];
    expect(events.length).toBe(3);
    const histogram = await runDuckdb(config, `${viewsSql(config.lakeDir)} SELECT count, sum FROM reports_hourly WHERE kind = 'histogram' LIMIT 1;`) as any[];
    expect(Number(histogram[0].count)).toBe(1);
  }, 120_000);
});
