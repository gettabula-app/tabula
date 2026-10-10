#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relayPath = path.join(root, 'server', 'relay.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(args) {
  const options = { ui: false, widths: [1280, 390], outDir: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--ui') options.ui = true;
    else if (arg === '--widths' || arg.startsWith('--widths=')) {
      const value = arg === '--widths' ? args[++i] : arg.slice('--widths='.length);
      if (!value) throw new Error('--widths needs a comma-separated list, for example 1280,390');
      options.widths = value.split(',').map((part) => Number(part.trim()));
      if (!options.widths.length || options.widths.some((width) => !Number.isInteger(width) || width < 320 || width > 7680)) {
        throw new Error('--widths values must be whole numbers from 320 to 7680');
      }
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      const value = arg === '--out' ? args[++i] : arg.slice('--out='.length);
      if (!value) throw new Error('--out needs a folder path');
      options.outDir = path.resolve(value);
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/qa-join-codes.mjs [--ui] [--widths 1280,390] [--out <folder>]');
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (new Set(options.widths).size !== options.widths.length) throw new Error('--widths cannot repeat a width');
  return options;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`FAIL  ${error.message}`);
  process.exit(2);
}

const results = [];
const liveSockets = new Set();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-join-codes-qa-'));
let port;
let base;
let relay = null;
let relayStderr = '';
let browser = null;

function record(name, ok, detail = '') {
  const status = ok ? 'PASS' : 'FAIL';
  results.push({ name, ok });
  console.log(`${status}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

function check(name, condition, detail = '') {
  record(name, Boolean(condition), detail);
  return Boolean(condition);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const assigned = address && typeof address === 'object' ? address.port : null;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!assigned) throw new Error('Could not reserve an available TCP port');
  return assigned;
}

function cleanChildEnvironment(flag) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(TABULA_|PORT$|HOST$|DATA_DIR$|DIST_DIR$|QUIET$)/.test(key)));
  Object.assign(env, {
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    DIST_DIR: path.join(root, 'dist'),
    QUIET: '1',
    TABULA_SKIP_DOTENV: '1',
    TABULA_AUTH: 'on',
    TABULA_MAIL: 'file',
    TABULA_OWNER_EMAIL: 'owner@example.test',
    TABULA_BASE_URL: base,
    TABULA_CHAT: 'on',
    TABULA_MCP: 'on',
    TABULA_JOIN_CODES: flag,
  });
  return env;
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (!relay || relay.exitCode !== null) break;
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(800) });
      if (response.ok) return;
    } catch { /* the relay is still starting */ }
    await sleep(100);
  }
  throw new Error(`Relay did not start on 127.0.0.1:${port}${relayStderr ? `: ${relayStderr.slice(-1200)}` : ''}`);
}

async function startRelay(flag) {
  if (relay) throw new Error('Refusing to start a second relay in this QA run');
  relayStderr = '';
  relay = spawn(process.execPath, [relayPath], {
    cwd: dataDir,
    env: cleanChildEnvironment(flag),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  relay.stderr.on('data', (chunk) => { relayStderr = (relayStderr + String(chunk)).slice(-8000); });
  await waitForHealth();
}

async function stopRelay() {
  if (!relay) return;
  const ownedRelay = relay;
  relay = null;
  if (ownedRelay.exitCode === null && ownedRelay.signalCode === null) {
    ownedRelay.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => ownedRelay.once('exit', resolve)),
      sleep(3500),
    ]);
    if (ownedRelay.exitCode === null && ownedRelay.signalCode === null) {
      ownedRelay.kill('SIGKILL');
      await Promise.race([
        new Promise((resolve) => ownedRelay.once('exit', resolve)),
        sleep(1500),
      ]);
    }
  }
}

async function call(method, route, body, cookie) {
  const request = {
    method,
    headers: {
      accept: 'application/json',
      'x-tabula': '1',
      origin: base,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    signal: AbortSignal.timeout(8000),
  };
  if (body !== undefined) request.body = JSON.stringify(body);
  const response = await fetch(`${base}${route}`, {
    ...request,
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, json, headers: response.headers, text };
}

async function loginOwner() {
  const requested = await call('POST', '/api/auth/request', { email: 'owner@example.test' });
  if (requested.status >= 400) throw new Error(`Owner sign-in link request returned ${requested.status}`);
  const outbox = path.join(dataDir, 'outbox.jsonl');
  let line;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (fs.existsSync(outbox)) line = fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).at(-1);
    if (line) break;
    await sleep(100);
  }
  if (!line) throw new Error('Owner sign-in link was not written to the throwaway outbox');
  const message = JSON.parse(line).text;
  const tokenMatch = /token=([^\s&]+)/.exec(message);
  if (!tokenMatch) throw new Error('Could not read the sign-in token from the throwaway outbox');
  const verified = await call('POST', '/api/auth/verify', { token: decodeURIComponent(tokenMatch[1]) });
  const setCookie = verified.headers.getSetCookie()[0];
  if (verified.status !== 200 || !setCookie) throw new Error(`Owner sign-in verification returned ${verified.status}`);
  const cookie = setCookie.split(';')[0];
  const named = await call('PATCH', '/api/me', { name: 'Olive Owner' }, cookie);
  if (named.status >= 400) throw new Error(`Could not set owner display name (${named.status})`);
  return cookie;
}

const createCode = (cookie, boardId, body) => call('POST', `/api/boards/${boardId}/join-codes`, body, cookie);
const joinAs = (code, name) => call('POST', '/api/join', { code, name });
const cookieOf = (response) => response.headers.getSetCookie()[0]?.split(';')[0] ?? null;

function openSocket(room, cookie) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sync/${room}`, { headers: { origin: base, cookie } });
    const state = { ws, open: false, closed: null, http: null, error: null };
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(state);
    };
    ws.on('open', () => { state.open = true; finish(); });
    ws.on('close', (code, reason) => { state.closed = code; state.reason = String(reason); finish(); });
    ws.on('error', (error) => { state.error = error.message; finish(); });
    ws.on('unexpected-response', (_request, response) => { state.http = response.statusCode; finish(); });
    setTimeout(finish, 1800).unref();
  });
}

async function refusedSocket(room, cookie) {
  const state = await openSocket(room, cookie);
  if (state.open && state.closed === null && state.http === null) await sleep(500);
  const refused = !state.open || state.closed !== null || state.http !== null;
  if (state.ws.readyState === WebSocket.OPEN) state.ws.close();
  return { refused, open: state.open, closed: state.closed, http: state.http, error: state.error };
}

async function connectY(room, cookie) {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const state = { doc, awareness, ws: null, opened: false, closed: null, http: null, synced: false };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/sync/${room}`, { headers: { origin: base, cookie } });
  state.ws = ws;
  ws.binaryType = 'arraybuffer';
  liveSockets.add(state);
  ws.on('error', () => {});
  ws.on('unexpected-response', (_request, response) => { state.http = response.statusCode; });
  ws.on('close', (code, reason) => { state.closed = code; state.reason = String(reason); });
  doc.on('update', (update, origin) => {
    if (origin === 'remote' || ws.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.writeUpdate(encoder, update);
    ws.send(encoding.toUint8Array(encoder));
  });
  awareness.on('update', ({ added, updated, removed }) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]));
    ws.send(encoding.toUint8Array(encoder));
  });
  ws.on('open', () => {
    state.opened = true;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.writeSyncStep1(encoder, doc);
    ws.send(encoding.toUint8Array(encoder));
  });
  ws.on('message', (data) => {
    try {
      const decoder = decoding.createDecoder(new Uint8Array(data));
      const type = decoding.readVarUint(decoder);
      if (type === 0) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        syncProtocol.readSyncMessage(decoder, encoder, doc, 'remote');
        if (encoding.length(encoder) > 1 && ws.readyState === WebSocket.OPEN) ws.send(encoding.toUint8Array(encoder));
        state.synced = true;
      } else if (type === 1) awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), 'remote');
    } catch (error) {
      state.protocolError = error.message;
    }
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out opening sync room ${room}`)), 5000);
    ws.once('open', () => { clearTimeout(timeout); resolve(); });
    ws.once('unexpected-response', (_request, response) => {
      clearTimeout(timeout);
      reject(new Error(`Sync room ${room} returned HTTP ${response.statusCode}`));
    });
    ws.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
  await sleep(500);
  return state;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true;
    await sleep(50);
  }
  return Boolean(await predicate());
}

async function closeY(state) {
  if (!state) return;
  state.awareness.destroy();
  if (state.ws.readyState === WebSocket.OPEN) state.ws.close();
  await waitFor(() => state.closed !== null, 600);
  liveSockets.delete(state);
}

function setExpiry(joinCodeId, expiresAt) {
  const db = new DatabaseSync(path.join(dataDir, 'directory.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout=5000');
    db.prepare('UPDATE join_codes SET expires_at = ? WHERE id = ?').run(expiresAt, joinCodeId);
    db.prepare('UPDATE guest_sessions SET expires_at = ? WHERE join_code_id = ?').run(expiresAt, joinCodeId);
  } finally {
    db.close();
  }
}

async function apiChecks(ownerCookie) {
  const config = await call('GET', '/api/config');
  check('[API] config advertises joinCodes when on', config.status === 200 && config.json.joinCodes === true);

  const createdBoard = await call('POST', '/api/boards', { id: 'qa-board', title: 'Join Code QA' }, ownerCookie);
  const otherBoard = await call('POST', '/api/boards', { id: 'qa-other', title: 'Other Board' }, ownerCookie);
  check('[API] owner creates test boards', createdBoard.status === 201 && otherBoard.status === 201, `${createdBoard.status}/${otherBoard.status}`);

  const editorCode = await createCode(ownerCookie, 'qa-board', { role: 'editor', expiresInHours: 3, maxUses: 100 });
  const commenterCode = await createCode(ownerCookie, 'qa-board', { role: 'commenter', expiresInHours: 3, maxUses: 100 });
  check('[API] create editor and commenter codes', editorCode.status === 201 && commenterCode.status === 201
    && /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(editorCode.json.code)
    && editorCode.json.role === 'editor' && commenterCode.json.role === 'commenter');
  const listedCodes = await call('GET', '/api/boards/qa-board/join-codes', undefined, ownerCookie);
  check('[API] list hides the one-time code', listedCodes.status === 200 && !JSON.stringify(listedCodes.json).includes(editorCode.json.code));
  const invalidRoles = await Promise.all([
    createCode(ownerCookie, 'qa-board', { role: 'owner' }),
    createCode(ownerCookie, 'qa-board', { role: 'editor', expiresInHours: 25 }),
    createCode(ownerCookie, 'qa-board', { role: 'editor', maxUses: 1001 }),
  ]);
  check('[API] reject invalid role, expiry and use limit', invalidRoles.every((result) => result.status === 400));
  check('[API] signed-out caller cannot create a code', (await createCode(null, 'qa-board', { role: 'editor' })).status >= 400);

  const editorJoin = await joinAs(editorCode.json.code, '  Gus\u200b   Guest ');
  const commenterJoin = await joinAs(commenterCode.json.code, 'Cora Commenter');
  const editorCookie = cookieOf(editorJoin);
  const commenterCookie = cookieOf(commenterJoin);
  check('[API] guests join as editor and commenter', editorJoin.status === 201 && commenterJoin.status === 201
    && editorJoin.json.role === 'editor' && commenterJoin.json.role === 'commenter');
  check('[API] guest name is sanitised', editorJoin.json.name === 'Gus Guest', JSON.stringify(editorJoin.json.name));
  const editorSetCookie = editorJoin.headers.getSetCookie()[0] ?? '';
  check('[API] guest cookie is HttpOnly and host-only', /HttpOnly/i.test(editorSetCookie) && !/Domain=/i.test(editorSetCookie));

  const wrong = await Promise.all(['ZZZZZZZZ', 'ABC', '', `${editorCode.json.code.slice(0, 7)}Q`].map((code) => joinAs(code, 'Nobody')));
  check('[API] invalid codes share one generic 404', wrong.every((result) => result.status === 404 && JSON.stringify(result.json) === JSON.stringify(wrong[0].json)));
  const probes = [
    '/api/boards', '/api/boards/qa-other', '/api/boards/qa-other/join-codes', '/api/teams',
    '/api/admin/users', '/api/admin/stats', '/api/chat/channels', '/api/ai/config', '/api/me/tokens',
    '/api/access-tokens', '/api/health', '/api/templates', '/api/auth/session',
  ];
  const surface = await Promise.all(probes.map((route) => call('GET', route, undefined, editorCookie)));
  check('[API] guest HTTP surface refuses unrelated routes', surface.every((result) => result.status >= 400), surface.map((result) => result.status).join('/'));
  const mcp = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { cookie: editorCookie, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: '{}', signal: AbortSignal.timeout(8000),
  });
  check('[API] guest /mcp is refused', mcp.status >= 400, String(mcp.status));
  check('[API] guest cannot read board metadata outside the allowed HTTP surface',
    (await call('GET', '/api/boards/qa-board', undefined, editorCookie)).status >= 400);
  check('[API] guest cannot create a board or code',
    (await call('POST', '/api/boards', { id: 'guest-board' }, editorCookie)).status >= 400
    && (await createCode(editorCookie, 'qa-board', { role: 'editor' })).status >= 400);
  check('[API] guest AI run is refused', (await call('POST', '/api/ai/run', { boardId: 'qa-board' }, editorCookie)).status >= 400);

  const chat = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/chat`, { headers: { origin: base, cookie: editorCookie } });
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    ws.on('open', () => { finish('open'); ws.close(); });
    ws.on('unexpected-response', (_request, response) => finish(`http ${response.statusCode}`));
    ws.on('error', () => finish('error'));
    ws.on('close', () => finish('closed'));
    setTimeout(() => finish('timeout'), 1800).unref();
  });
  check('[API] guest /chat websocket is refused', chat !== 'open', String(chat));

  const otherRoom = await refusedSocket('qa-other', editorCookie);
  const otherComments = await refusedSocket('qa-other~comments', commenterCookie);
  check('[API] guest cannot open another board or comments room', otherRoom.refused && otherComments.refused);

  const ownerBoard = await connectY('qa-board', ownerCookie);
  const editorBoard = await connectY('qa-board', editorCookie);
  const commenterBoard = await connectY('qa-board', commenterCookie);
  const ownerComments = await connectY('qa-board~comments', ownerCookie);
  const commenterComments = await connectY('qa-board~comments', commenterCookie);
  ownerBoard.doc.getMap('qa').set('ownerValue', 'hello');
  const editorRead = await waitFor(() => editorBoard.doc.getMap('qa').get('ownerValue') === 'hello');
  const commenterRead = await waitFor(() => commenterBoard.doc.getMap('qa').get('ownerValue') === 'hello');
  check('[API] editor and commenter guests sync the board', editorRead && commenterRead && editorBoard.synced && commenterBoard.synced);
  editorBoard.doc.getMap('qa').set('editorValue', 'guest edit');
  const editorWrite = await waitFor(() => ownerBoard.doc.getMap('qa').get('editorValue') === 'guest edit');
  check('[API] editor guest can write the board', editorWrite);
  commenterBoard.doc.getMap('qa').set('commenterValue', 'blocked');
  await sleep(450);
  check('[API] commenter guest cannot write the board', ownerBoard.doc.getMap('qa').get('commenterValue') === undefined);
  check('[API] owner and commenter guest sync the comments room', ownerComments.synced && commenterComments.synced && commenterComments.closed === null);
  const awareness = ownerBoard.awareness;
  awareness.setLocalStateField('user', { id: 'trusted-owner', name: 'Olive Owner', color: '#000000' });
  editorBoard.awareness.setLocalStateField('user', { id: 'forged', name: 'Olive Owner', color: '#ff0000', guest: false, role: 'owner' });
  const safePresence = await waitFor(() => [...awareness.getStates().values()].some((state) => state.user?.guest === true));
  const presenceUsers = [...awareness.getStates().values()].map((state) => state.user).filter(Boolean);
  check('[API] relay marks guest presence and blocks forged identity', safePresence
    && presenceUsers.some((user) => user.guest === true && user.name === 'Gus Guest')
    && !presenceUsers.some((user) => user.id === 'forged'));

  const useCode = await createCode(ownerCookie, 'qa-board', { role: 'editor', expiresInHours: 3, maxUses: 3 });
  const useOne = await joinAs(useCode.json.code, 'Use One');
  const useTwo = await joinAs(useCode.json.code, 'Use Two');
  const useThree = await joinAs(useCode.json.code, 'Use Three');
  const useFour = await joinAs(useCode.json.code, 'Use Four');
  check('[API] use limit allows three sessions then refuses the fourth', useOne.status === 201 && useTwo.status === 201
    && useThree.status === 201 && useFour.status === 404,
    `${useOne.status}/${useTwo.status}/${useThree.status}/${useFour.status}`);
  check('[API] use limit leaves an existing session active', (await call('GET', '/api/boards/qa-board/join-codes', undefined, ownerCookie)).status === 200
    && editorBoard.closed === null);

  const revoke = await call('DELETE', `/api/boards/qa-board/join-codes/${editorCode.json.id}`, undefined, ownerCookie);
  const kicked = await waitFor(() => editorBoard.closed !== null, 6000);
  check('[API] revoke ends the live guest socket', revoke.status === 204 && kicked, `status ${revoke.status}`);
  check('[API] revoked code and guest cookie are refused', (await joinAs(editorCode.json.code, 'Again')).status === 404
    && (await call('GET', '/api/boards', undefined, editorCookie)).status >= 400
    && (await refusedSocket('qa-board', editorCookie)).refused);
  check('[API] revoke does not affect a guest from another code', commenterBoard.closed === null);

  const expiringCode = await createCode(ownerCookie, 'qa-board', { role: 'editor', expiresInHours: 1 });
  const expiringJoin = await joinAs(expiringCode.json.code, 'Short Lived');
  const expiringCookie = cookieOf(expiringJoin);
  const expiringSocket = await connectY('qa-board', expiringCookie);
  setExpiry(expiringCode.json.id, Date.now() + 1300);
  // The relay throttles role checks to five seconds; poke the live socket after that window to test DB expiry.
  await sleep(5200);
  expiringSocket.awareness.setLocalStateField('expiryProbe', Date.now());
  await sleep(250);
  check('[API] expiry closes the live guest socket', expiringSocket.closed !== null, `close ${expiringSocket.closed}`);
  check('[API] expired code and cookie are refused', (await joinAs(expiringCode.json.code, 'Too Late')).status === 404
    && (await call('GET', '/api/boards', undefined, expiringCookie)).status >= 400);

  const rateCode = await createCode(ownerCookie, 'qa-board', { role: 'commenter', expiresInHours: 3, maxUses: 100 });
  await Promise.all([...liveSockets].map(closeY));
  return { commenterCookie, editorCookie, rateCode: rateCode.json, ownerCookie };
}

function cookieForBrowser(cookie) {
  const [name, value] = cookie.split('=', 2);
  return { name, value, url: base };
}

function observeBrowserErrors(page, errors, tag) {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const source = message.location().url ?? '';
    // The public font catalogue may be unavailable in an offline QA run; auth probes and invalid join requests
    // also produce expected 401/404 resource messages. Keep recording all other console errors.
    if (/fontshare/i.test(`${text} ${source}`) || /Failed to load resource: the server responded with a status of (401|404)/.test(text)) return;
    errors.push(`${tag}: ${text}${source ? ` [${source}]` : ''}`);
  });
  page.on('pageerror', (error) => errors.push(`${tag}: ${error.message}`));
}

async function screenshot(page, name) {
  if (!options.outDir) return;
  await page.screenshot({ path: path.join(options.outDir, name), fullPage: true });
}

async function createUiCode(page, role, tag) {
  const dialog = page.locator('.modal[role="dialog"]');
  if (await dialog.count() === 0) {
    await page.getByRole('button', { name: /^Share/ }).first().click();
    await dialog.waitFor({ state: 'visible' });
  }
  await dialog.getByLabel('Guest role').selectOption(role);
  await dialog.getByRole('button', { name: 'Create code', exact: true }).click();
  const codeInput = dialog.getByLabel('New join code');
  await codeInput.waitFor({ state: 'visible', timeout: 7000 });
  await page.waitForTimeout(100);
  const code = await codeInput.inputValue();
  const metrics = await codeInput.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight };
  });
  const viewport = page.viewportSize();
  const inView = metrics.x >= 0 && metrics.y >= 0 && metrics.right <= metrics.width && metrics.bottom <= metrics.height;
  check(`[UI ${viewport?.width}px] ${tag}: one-time code is visible after Create code`,
    /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(code) && await codeInput.isVisible() && inView,
    inView ? 'code field fits in the viewport' : `outside viewport: ${JSON.stringify(metrics)}`);
  await screenshot(page, `${tag}-share-code-${viewport?.width}.png`);
  return code;
}

async function joinFromUi(context, code, name, spaced = false, errors = null, tag = '') {
  const page = await context.newPage();
  if (errors && tag) observeBrowserErrors(page, errors, tag);
  await page.goto(`${base}/join${spaced ? '' : `?c=${encodeURIComponent(code)}`}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Join with a code' }).waitFor({ state: 'visible', timeout: 7000 });
  const codeInput = page.locator('input[name="code"]');
  if (spaced) await codeInput.fill(`${code.slice(0, 4)} ${code.slice(4)}`);
  const cleaned = await codeInput.inputValue();
  await page.locator('input[name="name"]').fill(name);
  await page.getByRole('button', { name: 'Join board', exact: true }).click();
  await page.waitForURL(/#\/b\/qa-board/, { timeout: 10000 });
  await page.locator('.canvas').waitFor({ state: 'visible', timeout: 12000 });
  return { page, cleaned };
}

async function openCommentComposer(page, phone, pass) {
  const canvas = page.locator('.canvas').first();
  const card = page.locator('.comment-card[role="dialog"]');
  const points = pass === 1
    ? [[0.35, 0.35], [0.72, 0.68], [0.24, 0.74], [0.8, 0.24]]
    : [[0.72, 0.68], [0.35, 0.35], [0.8, 0.24], [0.24, 0.74]];
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Commenter guest canvas has no visible bounds');
  for (const [xRatio, yRatio] of points) {
    await page.getByRole('button', { name: 'Comment', exact: true }).first().click();
    const point = { x: bounds.x + bounds.width * xRatio, y: bounds.y + bounds.height * yRatio };
    if (phone) await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    await card.waitFor({ state: 'visible', timeout: 5000 });
    const submit = card.locator('button.btn.primary').last();
    const action = await submit.innerText().catch(() => '');
    if (action === 'Comment') return card;
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'hidden', timeout: 3000 });
  }
  throw new Error('Could not place a new comment instead of opening an existing thread');
}

async function uiPass(width, pass, ownerCookie, errors) {
  const phone = width < 600;
  const context = await browser.newContext({
    viewport: { width, height: phone ? 844 : 800 },
    hasTouch: phone,
    isMobile: phone,
  });
  context.setDefaultTimeout(8000);
  await context.addCookies([cookieForBrowser(ownerCookie)]);
  const owner = await context.newPage();
  observeBrowserErrors(owner, errors, `owner ${width}/${pass}`);
  const tag = `w${width}-p${pass}`;
  const editorName = `Editor ${tag}`;
  const commenterName = `Commenter ${tag}`;
  let editorContext;
  let commenterContext;
  try {
    await owner.goto(`${base}/#/b/qa-board`, { waitUntil: 'domcontentloaded' });
    await owner.locator('.canvas').waitFor({ state: 'visible', timeout: 12000 });
    await sleep(350);
    const beforeCodes = await call('GET', '/api/boards/qa-board/join-codes', undefined, ownerCookie);
    if (beforeCodes.status !== 200) throw new Error(`Owner could not list join codes (${beforeCodes.status})`);
    const oldCodeIds = new Set(beforeCodes.json.map((code) => code.id));
    const editorCode = await createUiCode(owner, 'editor', `${tag} editor`);
    const commenterCode = await createUiCode(owner, 'commenter', `${tag} commenter`);
    const afterCodes = await call('GET', '/api/boards/qa-board/join-codes', undefined, ownerCookie);
    const createdEditor = afterCodes.json.find((code) => code.role === 'editor' && !oldCodeIds.has(code.id));
    const editorRowIndex = afterCodes.json.findIndex((code) => code.id === createdEditor?.id);
    if (!createdEditor || editorRowIndex < 0) throw new Error('Could not identify the editor code created in this UI pass');
    await owner.locator('.modal[role="dialog"]').getByRole('button', { name: 'Done', exact: true }).click();

    editorContext = await owner.context().browser().newContext({ viewport: { width, height: phone ? 844 : 800 }, hasTouch: phone, isMobile: phone });
    const editorJoin = await joinFromUi(editorContext, editorCode, editorName, false, errors, `editor ${width}/${pass}`);
    check(`[UI ${width}px] ${tag}: editor guest reaches the board`, /#\/b\/qa-board/.test(editorJoin.page.url()));

    commenterContext = await owner.context().browser().newContext({ viewport: { width, height: phone ? 844 : 800 }, hasTouch: phone, isMobile: phone });
    const commenterJoin = await joinFromUi(commenterContext, commenterCode, commenterName, true, errors, `commenter ${width}/${pass}`);
    check(`[UI ${width}px] ${tag}: spaced join code is cleaned and joins`, commenterJoin.cleaned === commenterCode
      && /#\/b\/qa-board/.test(commenterJoin.page.url()), `input became ${commenterJoin.cleaned}`);
    check(`[UI ${width}px] ${tag}: guest board loads`, await commenterJoin.page.locator('.canvas').isVisible());
    await screenshot(commenterJoin.page, `${tag}-guest-board.png`);

    if (width >= 600) {
      const canvas = editorJoin.page.locator('.canvas').first();
      const box = await canvas.boundingBox();
      if (!box) throw new Error('Editor guest canvas has no visible bounds');
      await editorJoin.page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.55);
      const cursor = owner.locator('.remote-cursor span');
      await owner.waitForFunction((expected) => [...document.querySelectorAll('.remote-cursor span')]
        .some((node) => node.textContent === `${expected} · Guest`), editorName, { timeout: 6000 }).catch(() => {});
      const cursorLabels = await cursor.allTextContents();
      check(`[UI ${width}px] ${tag}: cursor label includes “· Guest”`, cursorLabels.includes(`${editorName} · Guest`), cursorLabels.join(' | '));
      await screenshot(owner, `${tag}-guest-cursor.png`);
    } else {
      const accessibleLabels = await owner.locator('.people .avatar[aria-label]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')));
      check(`[UI ${width}px] ${tag}: guest presence is identified`, accessibleLabels.includes(`Go to ${editorName} · Guest`));
    }

    await commenterJoin.page.getByRole('button', { name: 'Comment', exact: true }).first().click();
    const card = await openCommentComposer(commenterJoin.page, phone, pass);
    const commentText = `Guest comment ${tag}`;
    await card.locator('textarea:visible').first().fill(commentText);
    await card.getByRole('button', { name: 'Comment', exact: true }).click();
    await card.locator('.comment-msg').first().waitFor({ state: 'visible', timeout: 6000 });
    check(`[UI ${width}px] ${tag}: guest marker appears in the comment thread`,
      (await card.locator('.comment-guest').allTextContents()).includes('Guest'));
    await screenshot(commenterJoin.page, `${tag}-guest-comment-thread.png`);

    await owner.getByRole('button', { name: 'Comments', exact: true }).click();
    const row = owner.locator('.comment-row').filter({ hasText: commentText });
    await row.waitFor({ state: 'visible', timeout: 8000 });
    check(`[UI ${width}px] ${tag}: guest marker appears in comments list row`,
      (await row.locator('.comment-guest').allTextContents()).includes('Guest'));
    await screenshot(owner, `${tag}-guest-comments-list.png`);
    await row.click();
    const ownerThread = owner.locator('.comment-card[role="dialog"]');
    await ownerThread.waitFor({ state: 'visible', timeout: 5000 });
    check(`[UI ${width}px] ${tag}: guest marker appears in the opened thread`,
      (await ownerThread.locator('.comment-guest').allTextContents()).includes('Guest'));

    await owner.keyboard.press('Escape');
    await owner.getByRole('button', { name: /^Share/ }).first().click();
    const share = owner.locator('.modal[role="dialog"]');
    await share.waitFor({ state: 'visible' });
    const revokedRow = share.locator('.join-code-row').nth(editorRowIndex);
    await revokedRow.getByRole('button', { name: 'Revoke Editor join code' }).click();
    const revokedButton = revokedRow.locator('button');
    await waitFor(async () => await revokedButton.innerText().catch(() => '') === 'Revoked' && await revokedButton.isDisabled(), 6000);
    check(`[UI ${width}px] ${tag}: Share dialog revokes an editor code`, await revokedButton.innerText() === 'Revoked' && await revokedButton.isDisabled());

    await share.getByRole('button', { name: 'Done', exact: true }).click();
    await screenshot(owner, `${tag}-share-after-revoke.png`);
    record(`[UI ${width}px] ${tag}: full join, presence and comment flow`, true);
    await editorJoin.page.close();
    await commenterJoin.page.close();
  } finally {
    await editorContext?.close().catch(() => {});
    await commenterContext?.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function uiChecks(ownerCookie) {
  if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) throw new Error('Build the app first with npm run build:app before --ui');
  if (options.outDir) fs.mkdirSync(options.outDir, { recursive: true });
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    await stopRelay();
    await startRelay('on');
    for (const width of options.widths) {
      for (const pass of [1, 2]) {
        try {
          await uiPass(width, pass, ownerCookie, errors);
        } catch (error) {
          record(`[UI ${width}px] pass ${pass} completes`, false, error.message);
        }
      }
    }

    const expiryCode = await createCode(ownerCookie, 'qa-board', { role: 'commenter', expiresInHours: 1 });
    setExpiry(expiryCode.json.id, Date.now() - 1);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const expiredPage = await context.newPage();
    observeBrowserErrors(expiredPage, errors, 'expired join');
    await expiredPage.goto(`${base}/join?c=${expiryCode.json.code}`, { waitUntil: 'domcontentloaded' });
    await expiredPage.locator('input[name="name"]').fill('Expired Guest');
    await expiredPage.getByRole('button', { name: 'Join board', exact: true }).click();
    const invalid = expiredPage.getByRole('alert').filter({ hasText: 'This code is no longer valid' });
    await invalid.waitFor({ state: 'visible', timeout: 7000 }).catch(() => {});
    check('[UI 390px] expired code shows the join page error', await invalid.isVisible().catch(() => false));
    await screenshot(expiredPage, 'expired-code-error-390.png');
    await context.close();

    await stopRelay();
    await startRelay('off');
    const disabledContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await disabledContext.addCookies([cookieForBrowser(ownerCookie)]);
    const disabledPage = await disabledContext.newPage();
    observeBrowserErrors(disabledPage, errors, 'flag off');
    await disabledPage.goto(`${base}/#/b/qa-board`, { waitUntil: 'domcontentloaded' });
    await disabledPage.locator('.canvas').waitFor({ state: 'visible', timeout: 12000 });
    await disabledPage.getByRole('button', { name: /^Share/ }).first().click();
    const disabledShare = disabledPage.locator('.modal[role="dialog"]');
    await disabledShare.waitFor({ state: 'visible' });
    check('[UI 390px] flag off hides Join code from Share', !(await disabledShare.innerText()).includes('Join code'));
    await screenshot(disabledPage, 'share-flag-off-390.png');
    await disabledPage.close();
    await disabledContext.close();
    await stopRelay();
    await startRelay('on');
  } finally {
    await browser.close();
    browser = null;
  }
  check('[UI] browser console and page have no errors', errors.length === 0, errors.slice(0, 4).join(' | '));
}

async function rateLimitChecks(code) {
  await stopRelay();
  await startRelay('on');
  const sameCode = [];
  for (let attempt = 0; attempt < 6; attempt++) sameCode.push((await joinAs(code.code, `Rate ${attempt}`)).status);
  check('[API] rate limit: five joins per code per minute', sameCode.slice(0, 5).every((status) => status === 201) && sameCode[5] === 429,
    sameCode.join('/'));
  const sourceStatuses = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const suffix = String(attempt).padStart(2, '0');
    const invalid = `ABCD${suffix}QZ`;
    sourceStatuses.push((await joinAs(invalid, `Source ${attempt}`)).status);
  }
  check('[API] rate limit: twenty joins per source per minute', sourceStatuses.includes(429), sourceStatuses.join('/'));
}

async function featureFlagChecks(ownerCookie, guestCookie) {
  await stopRelay();
  await startRelay('off');
  const disabledConfig = await call('GET', '/api/config');
  check('[API] config hides joinCodes when off', disabledConfig.status === 200 && disabledConfig.json.joinCodes !== true);
  const joinOff = await joinAs('ABCDEFGH', 'No Join');
  const codesOff = await call('GET', '/api/boards/qa-board/join-codes', undefined, ownerCookie);
  check('[API] flag off returns 404 for join and code routes', joinOff.status === 404 && codesOff.status === 404,
    `${joinOff.status}/${codesOff.status}`);
  check('[API] flag off refuses an existing guest cookie and keeps owner access',
    (await call('GET', '/api/boards', undefined, guestCookie)).status >= 400
    && (await call('GET', '/api/boards', undefined, ownerCookie)).status === 200);
  await stopRelay();
  await startRelay('on');
  const restored = await openSocket('qa-board', guestCookie);
  check('[API] turning flag back on restores an unexpired guest session', restored.open);
  if (restored.open) restored.ws.close();
}

async function run() {
  if (options.ui && !fs.existsSync(path.join(root, 'dist', 'index.html'))) {
    throw new Error('Build the app first with npm run build:app before --ui');
  }
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await startRelay('on');
  const ownerCookie = await loginOwner();
  const apiState = await apiChecks(ownerCookie);
  if (options.ui) await uiChecks(ownerCookie);
  await rateLimitChecks(apiState.rateCode);
  await featureFlagChecks(ownerCookie, apiState.commenterCookie);
  if (process.env.QA_BREAK === '1') record('[QA] intentional QA_BREAK failure hook', false, 'failure injection requested');
}

try {
  await run();
} catch (error) {
  record('[QA] run completes without an unhandled error', false, error?.stack?.split('\n')[0] ?? String(error));
} finally {
  await Promise.all([...liveSockets].map(closeY));
  await stopRelay();
  if (browser) await browser.close().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok);
  console.log(`SUMMARY  ${results.length - failed.length}/${results.length} passed; ${failed.length} failed`);
  if (failed.length) console.log(`FAILURES  ${failed.map((result) => result.name).join(' | ')}`);
  process.exitCode = failed.length ? 1 : 0;
}
