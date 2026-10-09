// A local stand-in for the Anthropic Messages API, enough for server/ai/anthropic.mjs: it streams the structured answer of
// the feature that asked (a `groups` schema is a cluster, anything else a generate) as server-sent events, and records every
// call so a check can say that nothing else was reached. Used by scripts/check-ai-review.mjs (docs/ai.md, "Checking the
// review in a browser"); no network, 127.0.0.1 only. The relay is pointed at it with ANTHROPIC_BASE_URL.
import http from 'node:http';

function readBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('stub request exceeded 2 MB'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * @param {{ apiKey: string, model: string, answers: { generate: unknown, cluster: unknown } }} options
 * @returns {Promise<{ server: http.Server, base: string, calls: { method: string, path: string, model: string, apiKeyMatched: boolean, feature: string, requestFormat: string | null }[] }>}
 */
export async function startAnthropicStub({ apiKey, model, answers }) {
  const calls = [];
  let n = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const body = JSON.stringify({ data: [{ id: model, type: 'model', display_name: 'Local stub' }], has_more: false, first_id: model, last_id: model });
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'not_found_error', message: 'local stub route not found' } }));
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'invalid JSON' } }));
      return;
    }
    const schema = body.output_config?.format?.schema ?? {};
    const isGroup = Object.hasOwn(schema.properties ?? {}, 'groups');
    const answer = isGroup ? answers.cluster : answers.generate;
    calls.push({
      method: req.method,
      path: url.pathname,
      model: body.model,
      apiKeyMatched: req.headers['x-api-key'] === apiKey,
      feature: isGroup ? 'cluster' : 'generate',
      requestFormat: body.output_config?.format?.type ?? null,
    });
    const text = JSON.stringify(answer);
    const id = `msg_local_${++n}`;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(sseEvent('message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: body.model ?? model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 64, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }));
    res.write(sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    for (let i = 0; i < text.length; i += 48) {
      res.write(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 48) } }));
    }
    res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
    res.write(sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 45 } }));
    res.write(sseEvent('message_stop', { type: 'message_stop' }));
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return { server, base: `http://127.0.0.1:${address.port}`, calls };
}
