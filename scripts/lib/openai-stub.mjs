import http from 'node:http';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const FENCE = String.fromCharCode(96).repeat(3);

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('stub request exceeded 2 MB'));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(value));
}

function completionBody({ model, content, refusal = null }) {
  return {
    id: 'chatcmpl_local',
    object: 'chat.completion',
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content,
        ...(refusal === null ? {} : { refusal }),
      },
      finish_reason: refusal === null ? 'stop' : 'content_filter',
    }],
    usage: { prompt_tokens: 64, completion_tokens: 45, total_tokens: 109 },
  };
}

/**
 * A loopback-only OpenAI-compatible server for provider tests and local checks.
 * The call log intentionally contains request metadata only, never request bodies or keys.
 */
export async function startOpenAiStub({ apiKey, model, answers, mode = 'json_object' }) {
  const calls = [];
  let currentMode = mode;
  let id = 0;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    let body = null;
    if (request.method === 'POST') {
      try {
        body = JSON.parse(await readBody(request));
      } catch {
        calls.push({
          method: request.method ?? '',
          path: url.pathname,
          model: null,
          keyMatched: request.headers.authorization === 'Bearer ' + apiKey,
          hasResponseFormat: false,
          format: null,
          feature: null,
        });
        if (!response.destroyed) sendJson(response, 400, { error: { message: 'invalid JSON' } });
        return;
      }
    }

    const keyMatched = request.headers.authorization === 'Bearer ' + apiKey;
    // which feature asked, read the way the answer is chosen: a cluster's schema has a `groups` property
    const systemText = typeof body?.messages?.[0]?.content === 'string' ? body.messages[0].content : '';
    calls.push({
      method: request.method ?? '',
      path: url.pathname,
      model: typeof body?.model === 'string' ? body.model : null,
      keyMatched,
      hasResponseFormat: body?.response_format !== undefined,
      format: typeof body?.response_format?.type === 'string' ? body.response_format.type : null,
      feature: url.pathname.endsWith('/chat/completions') ? (/["']groups["']\s*:/.test(systemText) ? 'cluster' : 'generate') : null,
    });

    if (request.method === 'GET' && url.pathname === '/v1/models') {
      if (!keyMatched || currentMode === 'unauthorized') {
        sendJson(response, 401, { error: { message: 'unauthorized' } });
      } else if (currentMode === 'no_models') {
        sendJson(response, 404, { error: { message: 'not found' } });
      } else if (currentMode === 'rate_limit') {
        sendJson(response, 429, { error: { message: 'rate limited' } }, { 'retry-after': '7' });
      } else if (currentMode === 'server_error') {
        sendJson(response, 500, { error: { message: 'server error' } });
      } else if (currentMode === 'slow') {
        // Leave the socket open until the provider aborts it.
      } else {
        sendJson(response, 200, { object: 'list', data: [{ id: model, object: 'model' }] });
      }
      return;
    }

    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      sendJson(response, 404, { error: { message: 'not found' } });
      return;
    }
    if (!keyMatched || currentMode === 'unauthorized') {
      sendJson(response, 401, { error: { message: 'unauthorized' } });
      return;
    }
    if (currentMode === 'rate_limit') {
      sendJson(response, 429, { error: { message: 'rate limited' } }, { 'retry-after': '7' });
      return;
    }
    if (currentMode === 'server_error') {
      sendJson(response, 500, { error: { message: 'server error' } });
      return;
    }
    if (currentMode === 'slow') return;
    if (body?.model !== model) {
      sendJson(response, 404, { error: { code: 'model_not_found', message: 'model not found' } });
      return;
    }
    if (currentMode === 'reject_json_object' && body.response_format !== undefined) {
      sendJson(response, 400, { error: { message: 'response_format is not supported' } });
      return;
    }

    const system = body.messages?.find((message) => message.role === 'system')?.content ?? '';
    const answer = /["']groups["']\s*:/.test(system) ? answers.cluster : answers.generate;
    const json = JSON.stringify(answer);
    const userMessages = (body.messages ?? []).filter((message) => message.role === 'user');
    const lastUserMessage = userMessages.at(-1)?.content;
    const repaired = lastUserMessage === 'Your previous reply was not valid JSON. Reply again with only the JSON object.';
    let content = json;
    if (currentMode === 'reject_json_object' || currentMode === 'fenced') {
      content = FENCE + 'json\n' + json + '\n' + FENCE;
    } else if (currentMode === 'prose' && !repaired) {
      content = 'Here is the result in prose.';
    } else if (currentMode === 'always_prose') {
      content = 'Here is the result in prose.';
    }
    const refusal = currentMode === 'refusal' ? 'The request was declined.' : null;
    const result = completionBody({ model, content, refusal });
    result.id = 'chatcmpl_local_' + (++id);
    sendJson(response, 200, result);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    base: 'http://127.0.0.1:' + address.port + '/v1',
    calls,
    setMode(value) {
      currentMode = value;
    },
  };
}
