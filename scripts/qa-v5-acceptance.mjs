#!/usr/bin/env node

import { randomUUID } from 'node:crypto';

const CHECKS = [
  'whoami scopes',
  'tools/list scope filtering',
  'kanban container and todo/doing/done lanes',
  'read token cannot add, update, or move cards',
  'write token adds a todo card with link and due date',
  'unsafe links are rejected without creating cards',
  'invalid dates, label, title, and lane selection are rejected',
  'update title and past due date, then clear the link',
  'move to doing and done; same-stage move returns moved:false',
  'agent ownership and person ownerId refusal',
  'read token cannot delete objects',
  'cleanup script-created cards',
  'no tokens in output',
];

const HELP = 'Usage: node scripts/qa-v5-acceptance.mjs --url https://tabulahq.thetabula.cloud --board <boardId> [--kanban <containerId>] [--keep] [--json] [--pause-for-watch]';

function parseArgs(argv) {
  const options = { keep: false, json: false, pauseForWatch: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--keep') options.keep = true;
    else if (flag === '--json') options.json = true;
    else if (flag === '--pause-for-watch') options.pauseForWatch = true;
    else if (['--url', '--board', '--kanban'].includes(flag)) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      options[flag.slice(2)] = value;
      i += 1;
    } else {
      throw new Error('Unknown option');
    }
  }
  return options;
}

const results = new Map();
const createdIds = new Set();
const attemptedTitles = new Set();
const printed = [];
let runOptions;
let tokenWrite;
let tokenRead;

function setResult(index, passed, detail) {
  results.set(index, { name: CHECKS[index - 1], passed, detail });
}

function setSkipped(index, reason) {
  setResult(index, false, `not run: ${reason}`);
}

function safeDetail(value) {
  return String(value).replace(/[\r\n\t]+/g, ' ').slice(0, 400);
}

function outputContainsSecret(value) {
  const text = String(value);
  return [tokenWrite, tokenRead].some((secret) => typeof secret === 'string' && secret.length > 0 && text.includes(secret));
}

function writeOutput(value, stream = process.stdout) {
  const text = String(value);
  if (outputContainsSecret(text)) {
    const replacement = 'FAIL 13. no tokens in output — a secret was suppressed';
    printed.push(replacement);
    stream.write(`${replacement}\n`);
    setResult(13, false, 'a secret was suppressed before output');
    return false;
  }
  printed.push(text);
  stream.write(`${text}\n`);
  return true;
}

function resultLine(index) {
  const result = results.get(index);
  const status = result?.passed ? 'PASS' : 'FAIL';
  return `${status} ${index}. ${result?.name ?? CHECKS[index - 1]} — ${safeDetail(result?.detail ?? 'not run')}`;
}

function summary() {
  const passed = [...results.values()].filter((item) => item.passed).length;
  const failed = [...results.values()].filter((item) => !item.passed).length;
  return { passed, failed, total: results.size };
}

function finish() {
  const secretFree = ![...printed, ...[...results.keys()].map(resultLine)].some(outputContainsSecret);
  setResult(13, secretFree, secretFree ? 'neither token appears in the report or live message' : 'a secret was suppressed before output');

  if (runOptions?.json) {
    const report = {
      checks: [...results.keys()].sort((a, b) => a - b).map((index) => ({
        name: results.get(index).name,
        status: results.get(index).passed ? 'PASS' : 'FAIL',
        detail: safeDetail(results.get(index).detail),
      })),
      summary: { status: summary().failed === 0 ? 'PASS' : 'FAIL', ...summary() },
    };
    const serialized = JSON.stringify(report, null, 2);
    if (outputContainsSecret(serialized)) {
      process.stdout.write('{"error":"output suppressed because a secret was detected","summary":{"passed":0,"failed":1}}\n');
      process.exitCode = 1;
      return;
    }
    printed.push(serialized);
    process.stdout.write(`${serialized}\n`);
  } else {
    for (const index of [...results.keys()].sort((a, b) => a - b)) {
      const line = resultLine(index);
      if (outputContainsSecret(line)) {
        process.stdout.write('FAIL 13. no tokens in output — a secret was suppressed\n');
        setResult(13, false, 'a secret was suppressed before output');
        break;
      }
      printed.push(line);
      process.stdout.write(`${line}\n`);
    }
    const counts = summary();
    const status = counts.failed === 0 ? 'PASS' : 'FAIL';
    writeOutput(`${status} summary: ${counts.passed} passed, ${counts.failed} failed`);
  }
  if ([...results.values()].some((item) => !item.passed)) process.exitCode = 1;
}

function parseToolPayload(response) {
  if (!response?.result) return { ok: false, code: 'rpc_error', payload: null };
  const item = response.result.content?.find((entry) => entry.type === 'text');
  if (!item || typeof item.text !== 'string') return { ok: false, code: 'invalid_response', payload: null };
  const fenced = /\[board-content nonce=([0-9a-f]+)\]\n([\s\S]*)\n\[\/board-content nonce=\1\]$/.exec(item.text);
  let payload;
  try {
    payload = JSON.parse(fenced ? fenced[2] : item.text);
  } catch {
    return { ok: false, code: 'invalid_response', payload: null };
  }
  return {
    ok: response.result.isError !== true && !payload?.error,
    code: payload?.error ?? (response.result.isError ? 'tool_error' : null),
    payload,
  };
}

function baseUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('--url must be an http(s) base URL without credentials, query, or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

let rpcId = 0;
async function rpc(token, method, params) {
  const response = await fetch(`${runOptions.base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params === undefined ? {} : { params }) }),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, code: 'invalid_response', body: null };
  }
  if (!response.ok || body?.error) return { ok: false, code: body?.error?.data?.error ?? 'rpc_error', body };
  return { ok: true, body };
}

async function callTool(token, name, args = {}) {
  const response = await rpc(token, 'tools/call', { name, arguments: args });
  if (!response.ok) return { ok: false, code: response.code, payload: response.body };
  return parseToolPayload(response.body);
}

async function listCards(token, boardId, kanbanId) {
  const cards = [];
  let cursor;
  const seen = new Set();
  for (let page = 0; page < 50; page += 1) {
    const args = { boardId, kanbanId, limit: 100, ...(cursor ? { cursor } : {}) };
    const response = await callTool(token, 'list_kanban_cards', args);
    if (!response.ok || !Array.isArray(response.payload?.cards)) return { ok: false, code: response.code ?? 'invalid_response', cards };
    cards.push(...response.payload.cards);
    const next = response.payload.nextCursor;
    if (!next) return { ok: true, cards };
    if (seen.has(next)) return { ok: false, code: 'repeated_cursor', cards };
    seen.add(next);
    cursor = next;
  }
  return { ok: false, code: 'too_many_pages', cards };
}

function rememberCreated(card) {
  if (typeof card?.id === 'string') createdIds.add(card.id);
}

function ownAttemptMatches(cards) {
  for (const card of cards) {
    if (attemptedTitles.has(card.title)) rememberCreated(card);
  }
}

function dueInOneWeek() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString().slice(0, 10);
}

async function countBeforeAfterAdd(args, title) {
  attemptedTitles.add(title);
  const before = await listCards(tokenWrite, runOptions.board, args.kanbanId);
  if (!before.ok) return { ok: false, code: `before_${before.code}`, before: null, after: null, response: null };
  const response = await callTool(tokenWrite, 'add_kanban_card', args);
  rememberCreated(response.payload?.card);
  const after = await listCards(tokenWrite, runOptions.board, args.kanbanId);
  if (after.ok) ownAttemptMatches(after.cards);
  return { ok: after.ok, code: response.code, response, before: before.cards.length, after: after.ok ? after.cards.length : null, cards: after.cards };
}

function missingLaneMessage(code) {
  return `could not resolve all three stage lanes (${code}); create a kanban with To do, Doing, Done on the scratch board`;
}

async function runAcceptance() {
  if (!runOptions.board) {
    setResult(3, false, `--board is required; refusing to make any MCP request. ${HELP}`);
    return;
  }
  if (!runOptions.base) {
    setResult(3, false, 'a valid --url is required; refusing to make any MCP request');
    return;
  }
  if (!tokenWrite || !tokenRead) {
    setResult(1, false, 'set TABULA_TOKEN_WRITE and TABULA_TOKEN_READ in the environment');
    return;
  }

  let writeIdentity;
  let readIdentity;
  let writeTools;
  let readTools;
  let kanban;
  let kanbanLabels = [];
  let writeScopeOkay = false;
  let readScopeOkay = false;
  let primaryId;
  let primaryTitle;
  const laneByStage = new Map();
  let cleanupResult;

  try {
    const writeWho = await callTool(tokenWrite, 'whoami');
    const readWho = await callTool(tokenRead, 'whoami');
    if (writeWho.ok) writeIdentity = writeWho.payload;
    if (readWho.ok) readIdentity = readWho.payload;
    writeScopeOkay = writeIdentity?.token?.scope === 'write';
    readScopeOkay = readIdentity?.token?.scope === 'read';
    setResult(1, writeScopeOkay && readScopeOkay,
      `write token scope ${writeIdentity?.token?.scope ?? 'unavailable'}; read token scope ${readIdentity?.token?.scope ?? 'unavailable'}`);

    const writeList = await rpc(tokenWrite, 'tools/list');
    const readList = await rpc(tokenRead, 'tools/list');
    writeTools = writeList.ok ? (writeList.body.result?.tools ?? []).map((tool) => tool.name) : [];
    readTools = readList.ok ? (readList.body.result?.tools ?? []).map((tool) => tool.name) : [];
    const writeExpected = ['list_kanban_cards', 'add_kanban_card', 'update_kanban_card', 'move_kanban_card'];
    const writeOkay = writeExpected.every((name) => writeTools.includes(name));
    const readOkay = readTools.includes('list_kanban_cards') &&
      !['add_kanban_card', 'update_kanban_card', 'move_kanban_card'].some((name) => readTools.includes(name));
    setResult(2, writeList.ok && readList.ok && writeOkay && readOkay,
      `write tools ${writeOkay ? 'present' : 'incomplete'}; read list_kanban_cards ${readTools.includes('list_kanban_cards') ? 'present' : 'missing'}; read write tools ${readOkay ? 'hidden' : 'unexpectedly visible'}`);

    let containerIds = [];
    if (runOptions.kanban) {
      const details = await callTool(tokenWrite, 'get_objects', { boardId: runOptions.board, ids: [runOptions.kanban] });
      const object = details.ok ? details.payload.objects?.find((item) => item.id === runOptions.kanban) : null;
      const listed = await callTool(tokenWrite, 'list_kanban_cards', { boardId: runOptions.board, kanbanId: runOptions.kanban });
      if (object?.type === 'container' && listed.ok && listed.payload.kanban?.id === runOptions.kanban) {
        kanban = { id: runOptions.kanban, initial: listed.payload };
      }
    } else {
      let cursor;
      const seen = new Set();
      for (let page = 0; page < 50; page += 1) {
        const boardPage = await callTool(tokenWrite, 'get_board', { boardId: runOptions.board, limit: 500, types: ['container'], ...(cursor ? { cursor } : {}) });
        if (!boardPage.ok) break;
        containerIds.push(...(boardPage.payload.objects ?? []).filter((object) => object.type === 'container').map((object) => object.id));
        cursor = boardPage.payload.nextCursor;
        if (!cursor) break;
        if (seen.has(cursor)) break;
        seen.add(cursor);
      }
      for (const id of containerIds) {
        const listed = await callTool(tokenWrite, 'list_kanban_cards', { boardId: runOptions.board, kanbanId: id });
        if (listed.ok && listed.payload.kanban?.id === id) {
          kanban = { id, initial: listed.payload };
          break;
        }
      }
    }

    if (kanban) {
      kanbanLabels = Array.isArray(kanban.initial.labels) ? kanban.initial.labels : [];
      for (const card of kanban.initial.cards ?? []) {
        if (card.stage && card.lane?.id && card.lane?.name) laneByStage.set(card.stage, { id: card.lane.id, name: card.lane.name });
      }
    }
    // Empty lanes do not appear in the current read response. Stage-targeted writes below verify them and return their names.
    setResult(3, Boolean(kanban), kanban
      ? 'kanban container found; stage lanes are checked from the server-resolved lane responses'
      : 'no kanban container was found; create a kanban with To do, Doing, Done on the scratch board');

    const readWriteTools = ['add_kanban_card', 'update_kanban_card', 'move_kanban_card'];
    if (!readScopeOkay) {
      setResult(4, false, 'read token does not have read scope; write probes were not sent');
    } else {
      const refused = readWriteTools.map((name) => !readTools.includes(name));
      const listedCards = kanban
        ? await callTool(tokenRead, 'list_kanban_cards', { boardId: runOptions.board, kanbanId: kanban.id })
        : { ok: false };
      const readListOkay = listedCards.ok && Array.isArray(listedCards.payload?.cards);
      setResult(4, readListOkay && refused.every(Boolean),
        `list_kanban_cards: ${readListOkay ? 'works' : 'failed'}; ` +
        readWriteTools.map((name, index) => `${name}: ${refused[index] ? 'not listed (refused)' : 'unexpectedly listed'}`).join('; '));
    }

    if (!kanban || !writeScopeOkay || !writeTools?.includes('add_kanban_card')) {
      setSkipped(5, !kanban ? 'no kanban container' : 'write token is not a valid write-scoped token');
      setSkipped(6, 'the step 5 card was not created');
      setSkipped(7, 'the step 5 card was not created');
      setSkipped(8, 'the step 5 card was not created');
      setSkipped(9, 'the step 5 card was not created');
      setSkipped(10, 'the step 5 card was not created');
    } else {
      if (runOptions.pauseForWatch) {
        const line = 'LIVE: watch the scratch board now; cards will appear';
        writeOutput(line, runOptions.json ? process.stderr : process.stdout);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }

      primaryTitle = `v5-accept ${runOptions.runId} roundtrip`;
      attemptedTitles.add(primaryTitle);
      const add = await callTool(tokenWrite, 'add_kanban_card', {
        boardId: runOptions.board,
        kanbanId: kanban.id,
        stage: 'todo',
        title: primaryTitle,
        description: `v5 acceptance run ${runOptions.runId}`,
        due: dueInOneWeek(),
        link: `https://example.com/v5-accept-${runOptions.runId}`,
        ...(kanbanLabels[0]?.id ? { labels: [kanbanLabels[0].id] } : {}),
      });
      rememberCreated(add.payload?.card);
      primaryId = add.payload?.card?.id;
      const afterAdd = await listCards(tokenWrite, runOptions.board, kanban.id);
      if (afterAdd.ok) ownAttemptMatches(afterAdd.cards);
      const listedPrimary = afterAdd.ok && primaryId
        ? afterAdd.cards.find((card) => card.id === primaryId)
        : null;
      const matchesAdd = add.ok && listedPrimary?.title === primaryTitle &&
        listedPrimary?.description === `v5 acceptance run ${runOptions.runId}` &&
        listedPrimary?.link === `https://example.com/v5-accept-${runOptions.runId}` &&
        listedPrimary?.due === add.payload.card.due && listedPrimary?.stage === 'todo' &&
        listedPrimary?.lane?.id && listedPrimary.lane.name;
      if (listedPrimary?.lane?.id && listedPrimary.lane.name) {
        laneByStage.set('todo', { id: listedPrimary.lane.id, name: listedPrimary.lane.name });
      }
      setResult(5, Boolean(matchesAdd), matchesAdd
        ? 'card appeared with the requested title, link, due date, and todo lane'
        : `${add.code ?? (add.ok ? 'card_missing_from_list' : 'add_failed')}; create a kanban with To do, Doing, Done on the scratch board`);
      if (!matchesAdd) setResult(3, false, missingLaneMessage('todo stage could not be verified'));

      if (!primaryId || !afterAdd.ok) {
        setSkipped(6, 'the step 5 card id or card list is unavailable');
        setSkipped(7, 'the step 5 card id or card list is unavailable');
        setSkipped(8, 'the step 5 card id or card list is unavailable');
        setSkipped(9, 'the step 5 card id or card list is unavailable');
        setSkipped(10, 'the step 5 card id or card list is unavailable');
      } else {
        const badLinks = [
          'javascript:alert(1)',
          'data:text/html;base64,AAAA',
          'ftp://x',
          'https://user:pass@example.com',
          'https://example.com/has space',
          `https://example.com/${'x'.repeat(2001 - 'https://example.com/'.length)}`,
          'https://example.com\\path',
        ];
        let linksOkay = true;
        const linkDetails = [];
        for (let index = 0; index < badLinks.length; index += 1) {
          const before = await listCards(tokenWrite, runOptions.board, kanban.id);
          const isUpdate = index % 2 === 1;
          const title = `v5-accept ${runOptions.runId} invalid-link-${index + 1}`;
          const response = isUpdate
            ? await callTool(tokenWrite, 'update_kanban_card', { boardId: runOptions.board, kanbanId: kanban.id, cardId: primaryId, link: badLinks[index] })
            : await countBeforeAfterAdd({ boardId: runOptions.board, kanbanId: kanban.id, stage: 'todo', title, link: badLinks[index] }, title);
          const after = isUpdate ? await listCards(tokenWrite, runOptions.board, kanban.id) : null;
          const afterCards = isUpdate ? after?.cards : response.cards;
          if (afterCards) ownAttemptMatches(afterCards);
          const beforeCount = isUpdate ? before.cards.length : response.before;
          const afterCount = isUpdate ? (after?.ok ? after.cards.length : null) : response.after;
          const expectedError = response.code === 'invalid_input';
          const afterListOkay = isUpdate ? after?.ok === true : response.ok === true;
          const unchangedCount = before.ok && afterListOkay && beforeCount !== null && afterCount === beforeCount;
          const current = after?.ok ? after.cards.find((card) => card.id === primaryId) : null;
          const updateUnchanged = !isUpdate || current?.link === `https://example.com/v5-accept-${runOptions.runId}`;
          const passed = expectedError && unchangedCount && updateUnchanged;
          linksOkay &&= passed;
          linkDetails.push(`${isUpdate ? 'update' : 'add'} ${index + 1}: ${response.code ?? 'accepted'}, count ${beforeCount ?? '?'}→${afterCount ?? '?'}`);
        }
        setResult(6, linksOkay, linkDetails.join('; '));

        const unknownLabel = `v5-invalid-${runOptions.runId}`;
        const invalidInputs = [
          ['due 2026-02-30', { due: '2026-02-30' }],
          ['due tomorrow', { due: 'tomorrow' }],
          ['unknown label id', { labels: [unknownLabel] }],
          ['201-character title', { title: `v5-accept ${runOptions.runId}${'x'.repeat(201 - `v5-accept ${runOptions.runId}`.length)}` }],
          ['laneId together with stage', { laneId: laneByStage.get('todo')?.id ?? add.payload.card.lane?.id, stage: 'todo' }],
        ];
        let inputsOkay = true;
        const inputDetails = [];
        for (let index = 0; index < invalidInputs.length; index += 1) {
          const [label, fields] = invalidInputs[index];
          const title = `v5-accept ${runOptions.runId} invalid-input-${index + 1}`;
          const response = await countBeforeAfterAdd({ boardId: runOptions.board, kanbanId: kanban.id, stage: 'todo', title, ...fields }, title);
          const passed = response.code === 'invalid_input' && response.before !== null && response.after === response.before;
          inputsOkay &&= passed;
          inputDetails.push(`${label}: ${response.code ?? 'accepted'}, count ${response.before ?? '?'}→${response.after ?? '?'}`);
        }
        setResult(7, inputsOkay, inputDetails.join('; '));

        const updatedTitle = `v5-accept ${runOptions.runId} updated`;
        const pastDue = '2001-02-03';
        const update = await callTool(tokenWrite, 'update_kanban_card', {
          boardId: runOptions.board, kanbanId: kanban.id, cardId: primaryId, title: updatedTitle, due: pastDue,
        });
        const afterUpdate = await listCards(tokenWrite, runOptions.board, kanban.id);
        const updatedCard = afterUpdate.ok && afterUpdate.cards.find((card) => card.id === primaryId);
        const updateOkay = update.ok && updatedCard?.title === updatedTitle && updatedCard?.due === pastDue;
        const clear = await callTool(tokenWrite, 'update_kanban_card', {
          boardId: runOptions.board, kanbanId: kanban.id, cardId: primaryId, link: null,
        });
        const afterClear = await listCards(tokenWrite, runOptions.board, kanban.id);
        const clearedCard = afterClear.ok && afterClear.cards.find((card) => card.id === primaryId);
        setResult(8, updateOkay && clear.ok && clearedCard && !Object.hasOwn(clearedCard, 'link'),
          updateOkay && clear.ok && clearedCard && !Object.hasOwn(clearedCard, 'link')
            ? 'title and past due date are listed; link:null cleared the link'
            : 'update or link clearing did not match the expected card state');

        let movesOkay = true;
        const moveDetails = [];
        for (const stage of ['doing', 'done']) {
          const moved = await callTool(tokenWrite, 'move_kanban_card', { boardId: runOptions.board, kanbanId: kanban.id, cardId: primaryId, stage });
          const currentList = await listCards(tokenWrite, runOptions.board, kanban.id);
          const current = currentList.ok && currentList.cards.find((card) => card.id === primaryId);
          const lane = moved.payload?.card?.lane;
          if (lane?.id && lane.name) laneByStage.set(stage, { id: lane.id, name: lane.name });
          const passed = moved.ok && moved.payload.moved === true && moved.payload.card?.stage === stage &&
            current?.stage === stage && current?.lane?.name === lane?.name;
          movesOkay &&= Boolean(passed);
          moveDetails.push(`${stage}: ${passed ? 'listed in resolved lane' : (moved.code ?? 'lane mismatch')}`);
        }
        const sameStage = await callTool(tokenWrite, 'move_kanban_card', { boardId: runOptions.board, kanbanId: kanban.id, cardId: primaryId, stage: 'done' });
        const sameOkay = sameStage.ok && sameStage.payload.moved === false;
        movesOkay &&= sameOkay;
        moveDetails.push(`already done: ${sameOkay ? 'moved:false' : (sameStage.code ?? 'unexpected move')}`);
        const stagesFound = ['todo', 'doing', 'done'].every((stage) => laneByStage.has(stage));
        setResult(3, stagesFound, stagesFound
          ? `kanban container found; lanes resolved for todo, doing, and done`
          : missingLaneMessage('one or more stage lanes are missing'));
        if (!movesOkay && !stagesFound) {
          moveDetails.push('create a kanban with To do, Doing, Done on the scratch board');
        }
        setResult(9, movesOkay, moveDetails.join('; '));

        const tokenName = writeIdentity?.token?.name;
        const agent = await callTool(tokenWrite, 'update_kanban_card', {
          boardId: runOptions.board, kanbanId: kanban.id, cardId: primaryId, ownerKind: 'agent',
        });
        const afterAgent = await listCards(tokenWrite, runOptions.board, kanban.id);
        const agentCard = afterAgent.ok && afterAgent.cards.find((card) => card.id === primaryId);
        const agentOkay = agent.ok && agentCard?.ownerKind === 'agent' && agentCard?.ownerName === tokenName;
        const person = await callTool(tokenWrite, 'update_kanban_card', {
          boardId: runOptions.board, kanbanId: kanban.id, cardId: primaryId,
          ownerId: `person-${runOptions.runId}`, ownerName: 'Acceptance person', ownerKind: 'person',
        });
        const afterPerson = await listCards(tokenWrite, runOptions.board, kanban.id);
        const personUnchanged = afterPerson.ok && afterPerson.cards.find((card) => card.id === primaryId)?.ownerKind === 'agent';
        setResult(10, agentOkay && person.code === 'invalid_input' && personUnchanged,
          agentOkay && person.code === 'invalid_input' && personUnchanged
            ? 'agent owner name matches the write token; a person ownerId was refused'
            : `agent owner ${agent.code ?? 'checked'}; person ownerId ${person.code ?? 'accepted'}`);
      }
    }

    if (readScopeOkay && primaryId && kanban) {
      const deletion = await callTool(tokenRead, 'delete_objects', { boardId: runOptions.board, ids: [primaryId] });
      setResult(11, !deletion.ok && deletion.code === 'forbidden', `delete_objects: ${deletion.code ?? 'unexpectedly accepted'}`);
    } else if (readScopeOkay) {
      const deletion = await callTool(tokenRead, 'delete_objects', { boardId: runOptions.board, ids: [`v5-${runOptions.runId}`] });
      setResult(11, !deletion.ok && deletion.code === 'forbidden', `delete_objects: ${deletion.code ?? 'unexpectedly accepted'}`);
    } else {
      setResult(11, false, 'not run: read token did not have read scope');
    }
  } catch {
    for (let i = 1; i <= 11; i += 1) if (!results.has(i)) setResult(i, false, 'unexpected request or response failure');
  } finally {
    if (runOptions.keep) {
      cleanupResult = { passed: true, detail: `--keep left ${createdIds.size} script-created card(s) on the board` };
    } else if (createdIds.size === 0) {
      cleanupResult = { passed: true, detail: 'no script-created cards remained' };
    } else if (writeScopeOkay && kanban) {
      try {
        const ids = [...createdIds];
        const deleted = await callTool(tokenWrite, 'delete_objects', { boardId: runOptions.board, ids });
        const after = await listCards(tokenWrite, runOptions.board, kanban.id);
        const noneRemain = after.ok && !after.cards.some((card) => ids.includes(card.id));
        cleanupResult = {
          passed: deleted.ok && ids.every((id) => deleted.payload?.deleted?.includes(id)) && noneRemain,
          detail: deleted.ok && noneRemain ? `deleted ${ids.length} explicit script-created id(s); none remain in the kanban` : `cleanup ${deleted.code ?? 'verification failed'}`,
        };
      } catch {
        cleanupResult = { passed: false, detail: 'cleanup request failed; script-created IDs could not be verified as deleted' };
      }
    } else {
      cleanupResult = { passed: false, detail: `${createdIds.size} script-created card(s) could not be deleted without a valid write token` };
    }
    setResult(12, cleanupResult.passed, cleanupResult.detail);
  }
}

try {
  runOptions = parseArgs(process.argv.slice(2));
  tokenWrite = process.env.TABULA_TOKEN_WRITE;
  tokenRead = process.env.TABULA_TOKEN_READ;
  runOptions.runId = randomUUID().slice(0, 12);
  if (runOptions.url) runOptions.base = baseUrl(runOptions.url);
  if (!runOptions.board) {
    setResult(3, false, `--board is required; refusing to make any MCP request. ${HELP}`);
  } else {
    await runAcceptance();
  }
} catch (error) {
  const message = error instanceof Error && /^(--url|--.* needs a value|Unknown option)/.test(error.message)
    ? error.message
    : HELP;
  setResult(3, false, safeDetail(message));
}

finish();
