#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { deleteWorkspace } from './delete.mjs';
import { applyRetention, compact, runDuckdb, validDay, viewsSql } from './lake.mjs';
import { createLogger } from './log.mjs';
import { issueToken, listTokens, revokeTokens } from './registry.mjs';
import { createCollector } from './server.mjs';

const USAGE = `usage: cli.mjs <command> [options]
  serve                                     run the collector HTTP service
  token issue --workspace <id> [--label <text>]   print a new bearer token once (or --control-plane for a token that
                                            names the workspace in each report)
  token revoke --id <token id> | --workspace <id>
  token list
  delete-workspace --workspace <id> [--keep-tokens]   remove the workspace from VictoriaMetrics, Loki, the lake and the spool
  compact [--day YYYY-MM-DD]                compact closed spool days into Parquet
  retention                                 drop lake partitions past their retention
  lake-daemon                               compact and apply retention on a schedule (the lake container)
  query "<sql>"                             DuckDB over the lake (views: reports_hourly, errors, events, status, alerts)
  vm-snapshot create|delete [name]          VictoriaMetrics snapshot for the backup job`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i += 1; }
    } else positional.push(arg);
  }
  return { flags, positional };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function lakeDaemon(config, log) {
  let lastRetentionDay = '';
  for (;;) {
    try {
      const results = await compact(config);
      for (const r of results) log.info('lake_compacted', { day: r.day, rows: r.rows, status: r.status });
      const today = new Date().toISOString().slice(0, 10);
      if (today !== lastRetentionDay) {
        const removed = await applyRetention(config);
        log.info('lake_retention', { removed: removed.length });
        lastRetentionDay = today;
      }
      fs.mkdirSync(path.dirname(config.heartbeatFile), { recursive: true });
      fs.writeFileSync(config.heartbeatFile, `${new Date().toISOString()}\n`);
    } catch (error) {
      log.error('lake_job_failed', { reason: String(error.message).slice(0, 200) });
    }
    await sleep(60 * 60 * 1000);
  }
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { flags, positional } = parseArgs(rest);
  const config = loadConfig();
  const log = createLogger();
  switch (command) {
    case 'serve': {
      const { server } = createCollector(config, { log });
      server.listen(config.port, config.host, () => log.info('listening', { port: config.port }));
      const stop = () => server.close(() => process.exit(0));
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
      return undefined;
    }
    case 'token': {
      const sub = positional[0];
      if (sub === 'issue') {
        const workspace = flags['control-plane'] ? null : flags.workspace;
        if (workspace === undefined || workspace === true) throw new Error('give --workspace <id> or --control-plane');
        const { id, token } = issueToken(config.registryFile, { workspace, label: typeof flags.label === 'string' ? flags.label : '' });
        process.stdout.write(`token id: ${id}\ntoken (shown once, store it now): ${token}\n`);
      } else if (sub === 'revoke') {
        const n = revokeTokens(config.registryFile, { id: typeof flags.id === 'string' ? flags.id : null, workspace: typeof flags.workspace === 'string' ? flags.workspace : null });
        process.stdout.write(`revoked ${n}\n`);
      } else if (sub === 'list') {
        process.stdout.write(`${JSON.stringify(listTokens(config.registryFile), null, 2)}\n`);
      } else throw new Error(USAGE);
      return undefined;
    }
    case 'delete-workspace': {
      if (typeof flags.workspace !== 'string') throw new Error('give --workspace <id>');
      const result = await deleteWorkspace(config, flags.workspace, { keepTokens: flags['keep-tokens'] === true, log });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
      return undefined;
    }
    case 'compact': {
      if (typeof flags.day === 'string' && !validDay(flags.day)) throw new Error('--day must be YYYY-MM-DD');
      process.stdout.write(`${JSON.stringify(await compact(config, { day: typeof flags.day === 'string' ? flags.day : null }), null, 2)}\n`);
      return undefined;
    }
    case 'retention':
      process.stdout.write(`${JSON.stringify(await applyRetention(config), null, 2)}\n`);
      return undefined;
    case 'lake-daemon':
      return lakeDaemon(config, log);
    case 'query': {
      const sql = positional[0];
      if (!sql) throw new Error('give a SQL string');
      process.stdout.write(await runDuckdb(config, `${viewsSql(config.lakeDir)}\n${sql}`, { raw: true }));
      return undefined;
    }
    case 'vm-snapshot': {
      const [action, name] = positional;
      const url = action === 'create' ? `${config.vmUrl}/snapshot/create` : action === 'delete' && name && /^[\w-]+$/u.test(name) ? `${config.vmUrl}/snapshot/delete?snapshot=${encodeURIComponent(name)}` : null;
      if (!url) throw new Error('vm-snapshot create | delete <name>');
      const response = await fetch(url, { method: 'POST' });
      process.stdout.write(`${await response.text()}\n`);
      if (!response.ok) process.exitCode = 1;
      return undefined;
    }
    default:
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 2;
      return undefined;
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
