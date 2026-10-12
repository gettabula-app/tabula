import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allSeriesNames } from '../telemetry-collector/src/map.mjs';

const root = path.resolve(__dirname, '..');
const stack = path.join(root, 'deploy', 'telemetry');
const read = (...parts: string[]) => fs.readFileSync(path.join(stack, ...parts), 'utf8');

function services(): Record<string, string> {
  const text = read('compose.yaml');
  const body = text.slice(text.indexOf('\nservices:\n') + 11, text.indexOf('\nnetworks:\n'));
  const blocks: Record<string, string> = {};
  let name = '';
  for (const line of body.split('\n')) {
    const m = /^ {2}([a-z]+):\s*$/u.exec(line);
    if (m) { name = m[1]; blocks[name] = ''; } else if (name) blocks[name] += `${line}\n`;
  }
  return blocks;
}

describe('compose file', () => {
  const blocks = services();

  it('defines the expected services, each with a restart policy, limits and a health check', () => {
    expect(Object.keys(blocks).sort()).toEqual(['collector', 'door', 'grafana', 'lake', 'loki', 'proxy', 'victoriametrics']);
    for (const [name, block] of Object.entries(blocks)) {
      expect(`${name}\n${block}`).toMatch(/<<: \*service[\s\S]*mem_limit: \d+[mg][\s\S]*cpus: [\d.]+[\s\S]*healthcheck:/u);
    }
    expect(read('compose.yaml')).toMatch(/restart: unless-stopped/u);
  });

  it('publishes only the two proxy doors and the optional TLS door, each on an explicit non-wildcard address that defaults to loopback', () => {
    const text = read('compose.yaml');
    const published = [...text.matchAll(/^\s+- "([^"]*:\d*[^"]*:\d+)"\s*$/gmu)].map((m) => m[1]);
    expect(published.length).toBe(4);
    for (const spec of published) expect(spec).toMatch(/^\$\{(?:GRAFANA|INGEST|DOOR)_BIND:-127\.0\.0\.1\}:/u);
    expect(blocks.proxy).toContain('ports:');
    const withPorts = Object.entries(blocks).filter(([, block]) => /^\s+ports:/mu.test(block)).map(([name]) => name);
    expect(withPorts).toEqual(['proxy', 'door']);
    // the TLS door is off unless its profile is switched on
    expect(blocks.door).toMatch(/profiles: \["door"\]/u);
    expect(text).not.toMatch(/network_mode:\s*host/u);
    expect(text).not.toMatch(/0\.0\.0\.0:\d/u);
    expect(text).not.toMatch(/privileged:/u);
  });

  it('avoids the ports of the other project on the shared host', () => {
    const text = read('compose.yaml') + read('.env.example');
    for (const port of [3000, 9090, 9093, 9100, 5432, 18100, 19100]) {
      expect(text).not.toMatch(new RegExp(`(?:^|[^0-9])${port}:\\d+|:${port}"`, 'u'));
    }
    expect(read('.env.example')).toMatch(/GRAFANA_PORT=8480/u);
    expect(read('.env.example')).toMatch(/INGEST_PORT=8481/u);
  });

  it('keeps secrets out: .env.example has no real value and Grafana credentials are required from the environment', () => {
    const env = read('.env.example');
    const credentialLines = env.split('\n').filter((line) => /^(GRAFANA_ADMIN_USER|GRAFANA_ADMIN_PASSWORD)=/u.test(line));
    expect(credentialLines).toEqual(['GRAFANA_ADMIN_USER=', 'GRAFANA_ADMIN_PASSWORD=']);
    expect(env).not.toMatch(/(?:token|secret|key)\s*=\s*\S/iu);
    expect(read('compose.yaml')).toMatch(/GRAFANA_ADMIN_PASSWORD:\?/u);
    expect(read('backup', 'backup.env.example')).toMatch(/STORAGEBOX_USER=\n/u);
    expect(read('backup', 'backup.env.example')).toMatch(/STORAGEBOX_HOST=\n/u);
  });

  it('has a Caddyfile that routes only the report endpoint and health check to the collector', () => {
    const caddy = read('Caddyfile').replace(/^\s*#.*$/gmu, '');
    expect(caddy).toContain('path /v1/telemetry /healthz');
    expect(caddy).not.toContain('/metrics');
    expect(caddy).toMatch(/auto_https off/u);
  });

  it('has a TLS door Caddyfile that lets only the allow-list reach two routes and answers 403 to everything else, on both ports', () => {
    const caddy = read('Caddyfile.door').replace(/^\s*#.*$/gmu, '');
    expect(caddy).toContain('http://{$DOOR_HOST}');
    expect(caddy).toMatch(/http:\/\/\{\$DOOR_HOST\} \{\s+respond "forbidden" 403/u);
    expect(caddy.match(/remote_ip \{\$DOOR_ALLOW\}/gu)?.length).toBe(2);
    expect(caddy).toMatch(/@report \{\s+remote_ip \{\$DOOR_ALLOW\}\s+method POST\s+path \/v1\/telemetry\s+\}/u);
    expect(caddy).toMatch(/@health \{\s+remote_ip \{\$DOOR_ALLOW\}\s+method GET\s+path \/healthz\s+\}/u);
    expect(caddy).toMatch(/:8082 \{\s+bind 127\.0\.0\.1/u);
    expect(caddy).toMatch(/handle \{\s+respond "forbidden" 403/u);
    expect(caddy).not.toContain('/metrics');
    expect(caddy).not.toMatch(/trusted_proxies|auto_https off|tls internal|X-Forwarded/iu);
  });

  it.skipIf(!dockerComposeAvailable())('passes `docker compose config` with dummy credentials and publishes on loopback', () => {
    const out = execFileSync('docker', ['compose', 'config', '--format', 'json'], {
      cwd: stack, encoding: 'utf8', env: { ...process.env, GRAFANA_ADMIN_USER: 'x', GRAFANA_ADMIN_PASSWORD: 'y' },
    });
    const config = JSON.parse(out);
    for (const service of Object.values<any>(config.services)) {
      for (const port of service.ports ?? []) expect(port.host_ip).toBe('127.0.0.1');
    }
  });
});

function dockerComposeAvailable(): boolean {
  try { execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

describe('preflight bind rules', () => {
  const run = (bind: string, approved = '') => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-preflight-'));
    const env = path.join(dir, 'env');
    fs.writeFileSync(env, `TELEMETRY_DATA=${dir}\nGRAFANA_BIND=${bind}\nGRAFANA_PORT=18480\nINGEST_BIND=127.0.0.1\nINGEST_PORT=18481\nGRAFANA_ADMIN_USER=u\nGRAFANA_ADMIN_PASSWORD=p\nAPPROVED_TUNNEL_ADDRESS=${approved}\n`);
    try {
      execFileSync('bash', [path.join(stack, 'scripts', 'preflight.sh'), env], { env: { ...process.env, PREFLIGHT_SKIP_LISTEN: '1' }, stdio: 'pipe' });
      return 'ok';
    } catch { return 'refused'; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  it('accepts loopback, a NetBird address and the one approved private address, and refuses everything else', () => {
    expect([run('127.0.0.1'), run('100.101.2.3'), run('10.8.0.2', '10.8.0.2')]).toEqual(['ok', 'ok', 'ok']);
    expect([run('0.0.0.0'), run(''), run('8.8.8.8'), run('10.8.0.2'), run('100.128.0.1'), run('192.168.1.5', '8.8.8.8')]).toEqual(Array(6).fill('refused'));
  });
});

describe('preflight rules for the TLS door', () => {
  const run = (door: Record<string, string>, profiles = 'door') => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-preflight-door-'));
    const env = path.join(dir, 'env');
    const lines = [`TELEMETRY_DATA=${dir}`, 'GRAFANA_BIND=127.0.0.1', 'GRAFANA_PORT=18480', 'INGEST_BIND=127.0.0.1', 'INGEST_PORT=18481', 'GRAFANA_ADMIN_USER=u', 'GRAFANA_ADMIN_PASSWORD=p',
      ...(profiles ? [`COMPOSE_PROFILES=${profiles}`] : []), ...Object.entries(door).map(([k, v]) => `${k}=${v}`)];
    fs.writeFileSync(env, `${lines.join('\n')}\n`);
    try {
      execFileSync('bash', [path.join(stack, 'scripts', 'preflight.sh'), env], { env: { ...process.env, PREFLIGHT_SKIP_LISTEN: '1' }, stdio: 'pipe' });
      return 'ok';
    } catch { return 'refused'; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const good = { DOOR_HOST: 'telemetry.example.org', DOOR_BIND: '203.0.113.10', DOOR_ALLOW: '198.51.100.7' };

  it('accepts a public name, this server\'s public IPv4 address and one or more single public egress addresses', () => {
    expect(run(good)).toBe('ok');
    expect(run({ ...good, DOOR_ALLOW: '198.51.100.7 198.51.100.8' })).toBe('ok');
  });

  it('ignores the door settings while its profile is off, and needs them when it is on', () => {
    expect(run({}, '')).toBe('ok');
    expect(run({ DOOR_BIND: '0.0.0.0' }, 'other')).toBe('ok');
    expect(run({}, 'door')).toBe('refused');
  });

  it.each([
    ['no host', { ...good, DOOR_HOST: '' }],
    ['a host that cannot be public', { ...good, DOOR_HOST: 'door.invalid' }],
    ['a bare label', { ...good, DOOR_HOST: 'telemetry' }],
    ['a wildcard bind', { ...good, DOOR_BIND: '0.0.0.0' }],
    ['a loopback bind', { ...good, DOOR_BIND: '127.0.0.1' }],
    ['a private bind', { ...good, DOOR_BIND: '10.0.0.5' }],
    ['an IPv6 bind', { ...good, DOOR_BIND: '2001:db8::10' }],
    ['no bind', { ...good, DOOR_BIND: '' }],
    ['an empty allow-list', { ...good, DOOR_ALLOW: '' }],
    ['a range in the allow-list', { ...good, DOOR_ALLOW: '198.51.100.0/24' }],
    ['everyone', { ...good, DOOR_ALLOW: '0.0.0.0' }],
    ['a private address in the allow-list', { ...good, DOOR_ALLOW: '198.51.100.7 192.168.1.4' }],
    ['an IPv6 address in the allow-list', { ...good, DOOR_ALLOW: '2001:db8::7' }],
  ])('refuses %s', (_name, door) => {
    expect(run(door)).toBe('refused');
  });
});

describe('dashboards as code', () => {
  const dir = path.join(stack, 'grafana', 'dashboards');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

  it('provides the five dashboards with unique ids and uids', () => {
    expect(files).toEqual(['backups-restore.json', 'errors.json', 'fleet-overview.json', 'product-usage.json', 'workspace-health.json']);
    const uids = new Set<string>();
    for (const file of files) {
      const dashboard = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      expect(uids.has(dashboard.uid)).toBe(false);
      uids.add(dashboard.uid);
      const ids = dashboard.panels.map((p: any) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('queries only series the collector writes, and only datasources that are provisioned', () => {
    const known = new Set([...allSeriesNames(), 'tabula_collector_reports_accepted_total', 'tabula_collector_reports_rejected_total']);
    const provisioned = read('grafana', 'provisioning', 'datasources', 'datasources.yaml');
    for (const file of files) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      const unknown = [...text.matchAll(/\btabula_[a-z0-9_]+/gu)].map((m) => m[0])
        .filter((name) => !name.startsWith('tabula_collector_') && !/^tabula_(?:vm|loki|fleet|workspace|backups|usage|errors)$/u.test(name) && !known.has(name));
      expect(unknown.map((name) => `${file}: ${name}`)).toEqual([]);
      for (const m of text.matchAll(/"uid": "(tabula-(?:vm|loki))"/gu)) expect(provisioned).toContain(`uid: ${m[1]}`);
    }
  });

  it('is in sync with the generator', () => {
    const before = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
    execFileSync('node', [path.join(stack, 'scripts', 'gen-dashboards.mjs')]);
    const after = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
    expect(after).toEqual(before);
  });
});

describe('docs and scripts', () => {
  it('has no em dashes in the stack files or the stack doc', () => {
    const targets = [path.join(root, 'docs', 'telemetry-stack.md')];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else if (!p.endsWith('.json')) targets.push(p);
      }
    };
    walk(stack);
    walk(path.join(root, 'telemetry-collector'));
    const withDash = targets.filter((file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(String.fromCodePoint(0x2014)));
    expect(withDash).toEqual([]);
  });
});
