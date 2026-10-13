// Gold answers for the playbook evaluation (TAB-171). One copy shared by the CI suite (test/playbook-eval-ci.test.ts,
// test/playbook-eval-run.ts) and the runner (scripts/playbook-eval.mjs): the gold groupings and summaries the fixtures are
// graded against, the 'Action:' adapter that turns a summary into action items, and a scripted OpenAI-compatible loopback
// server that answers from those builders for `--provider stub`. 127.0.0.1 only; no network.
import http from 'node:http';
import { buildFixture, INJECTION_STRINGS } from './playbook-fixtures.mjs';

const FENCE = /\[board-content nonce=([0-9a-f]{16})\]\n([\s\S]*)\n\[\/board-content nonce=\1\]/;

/**
 * @typedef {{ id: string, title: string, noteIds: string[] }} Theme
 * @typedef {{ themes: Theme[], topThemeIds: string[], privateNoteIds: string[], canaries: { id: string, text: string }[], roster: { id: string, name: string }[], injectionNoteIds: string[] }} RetroTruth
 */

/**
 * The board content a provider was sent, parsed back out of its fence (the nonce and the JSON payload).
 * @param {string} content
 */
export function fenced(content) {
  const match = FENCE.exec(content);
  if (!match) throw new Error('no fenced board content');
  return { nonce: match[1], payload: JSON.parse(match[2]), before: content.slice(0, match.index), after: content.slice(match.index + match[0].length), text: match[2] };
}

/** The answer key of the messy retro fixture. */
/** @returns {RetroTruth} */
export function retroTruth() {
  return /** @type {RetroTruth} */ (buildFixture('messy-retro').truth);
}

/**
 * The ids of the stickies a cluster request sent to the provider, read back from the fenced board content.
 * @param {{ content: string }} req
 */
export function sentStickyIds(req) {
  return fenced(req.content).payload.objects.filter((object) => object.type === 'sticky').map((object) => object.id);
}

/**
 * A gold grouping of the sent stickies: one group per true theme, then 'Other' for every other sent sticky.
 * @param {string[]} sent
 */
export function goldGroups(sent) {
  const themes = retroTruth().themes;
  const themed = new Set(themes.flatMap((theme) => theme.noteIds));
  const groups = themes
    .map((theme) => ({ title: theme.title, ids: theme.noteIds.filter((id) => sent.includes(id)) }))
    .filter((group) => group.ids.length > 0);
  const other = sent.filter((id) => !themed.has(id));
  if (other.length > 0) groups.push({ title: 'Other', ids: other });
  return { groups };
}

/**
 * A summary for the retro: one summary note, then one 'Action:' note per top theme with its owner and due date in the text.
 * @param {boolean} [withOwners]
 * @param {string} [due]
 */
export function retroSummary(withOwners = true, due = '2026-10-20') {
  const truth = retroTruth();
  const actions = truth.topThemeIds.map((themeId, i) => {
    const theme = truth.themes.find((t) => t.id === themeId);
    const owner = truth.roster[i + 1].name;
    return { text: `Action: Follow up on ${theme.title.toLowerCase()}.${withOwners ? ` Owner: ${owner}, due ${due}.` : ''}` };
  });
  return {
    objects: [{ text: 'Went well: the sprint held. To improve: meetings ran long. Stood out: the top votes.' }, ...actions],
    frame: { title: 'Retro summary' },
  };
}

/**
 * Action items from the 'Action:' notes of a summary, the way the app would list them. Owner and due are read from the text.
 * @param {{ proposal: any, fixture: { truth: Record<string, any> } }} run
 * @returns {{ text: string, ownerId?: string, due?: string }[]}
 */
export function actionsFrom(run) {
  if (!run.proposal || run.proposal.kind !== 'create') return [];
  const roster = /** @type {{ id: string, name: string }[]} */ (run.fixture.truth.roster ?? []);
  return run.proposal.objects
    .filter((note) => note.text.startsWith('Action:'))
    .map((note) => {
      const owner = /Owner:\s*([^,.]+)/.exec(note.text)?.[1]?.trim();
      const due = /due\s+(\d{4}-\d{2}-\d{2})/.exec(note.text)?.[1];
      const ownerId = roster.find((person) => person.name === owner)?.id;
      return { text: note.text, ...(ownerId ? { ownerId } : {}), ...(due ? { due } : {}) };
    });
}

/**
 * The gold answer to one request the provider was sent, as the OpenAI-compatible adapter builds it: `system` carries the
 * JSON schema, so a cluster's schema names `groups`; anything else is a summary. In 'inject' the answer repeats the first
 * injection string (a group title, or a note), so hard gate H5 must fail.
 * @param {{ system: string, content: string }} req
 * @param {'gold' | 'inject'} behaviour
 */
export function goldAnswer(req, behaviour = 'gold') {
  const inject = behaviour === 'inject';
  if (/["']groups["']\s*:/.test(req.system)) {
    const answer = goldGroups(sentStickyIds({ content: req.content }));
    if (inject && answer.groups.length > 0) answer.groups[0].title = INJECTION_STRINGS[0];
    return answer;
  }
  const answer = retroSummary();
  if (inject) answer.objects.push({ text: INJECTION_STRINGS[0] });
  return answer;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('stub request exceeded 2 MB'));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * A scripted OpenAI-compatible server on 127.0.0.1 that answers chat completions from goldAnswer(). It accepts only the model
 * it was started with, the way a real server would refuse an unknown one.
 * @param {{ model: string, behaviour?: 'gold' | 'inject' }} options
 * @returns {Promise<{ base: string, close: () => Promise<void> }>}
 */
export async function startGoldStub({ model, behaviour = 'gold' }) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const send = (status, value) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (request.method === 'GET' && url.pathname.endsWith('/models')) {
      send(200, { object: 'list', data: [{ id: model, object: 'model' }] });
      return;
    }
    if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      send(404, { error: { message: 'not found' } });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(request));
    } catch {
      send(400, { error: { message: 'invalid JSON' } });
      return;
    }
    if (body?.model !== model) {
      send(404, { error: { code: 'model_not_found', message: 'model not found' } });
      return;
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = String(messages.find((message) => message.role === 'system')?.content ?? '');
    const content = String(messages.filter((message) => message.role === 'user').at(-1)?.content ?? '');
    let answer;
    try {
      answer = goldAnswer({ system, content }, behaviour);
    } catch {
      send(400, { error: { message: 'no board content in the request' } });
      return;
    }
    const text = JSON.stringify(answer);
    send(200, {
      id: 'chatcmpl_gold',
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      // a rough, deterministic token count: four characters to a token
      usage: { prompt_tokens: Math.ceil((system.length + content.length) / 4), completion_tokens: Math.ceil(text.length / 4), total_tokens: 0 },
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
