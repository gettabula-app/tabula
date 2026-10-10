import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchImage, fetchImages, fetchPage, LINK_ICON_LIMIT, LINK_IMAGE_LIMIT, LINK_PAGE_LIMIT } from '../server/link-fetch.mjs';
import { isPublicLinkAddress } from '../server/link-guard.mjs';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
type LocalServer = { server: Server; port: number };
type RequestOptions = {
  protocol: string;
  hostname?: string;
  path?: string;
  maxHeaderSize?: number;
  servername?: string;
  rejectUnauthorized?: boolean;
  autoSelectFamily?: boolean;
};
type FakeRequest = EventEmitter & { end: () => void; destroy: () => void };
type RequestImpl = (options: RequestOptions, callback: (response: IncomingMessage) => void) => FakeRequest | ReturnType<typeof http.request>;

const servers: Server[] = [];

async function startServer(handler: Handler): Promise<LocalServer> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, port: (server.address() as { port: number }).port };
}

async function closeServer(server: Server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(closeServer));
});

function optionsFor(port: number, lookup: (hostname: string, options: { all: true; verbatim: true }) => Promise<{ address: string; family: number }[]> = async () => [
  { address: '127.0.0.1', family: 4 },
]) {
  return {
    lookup,
    isPublicAddress: (address: string) => address === '127.0.0.1' || isPublicLinkAddress(address),
    allowedPorts: { http: [port], https: [443] },
  };
}

function url(port: number, path = '/') {
  return `http://preview.test:${port}${path}`;
}

function html(response: ServerResponse, body = '<head><title>Local</title></head><body>body</body>') {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(body);
}

function pngBytes(size = 12) {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(Math.max(4, size - 8))]);
}

function fakeResponseRequest(statusCode: number, headers: Record<string, string>, body = Buffer.alloc(0)): RequestImpl {
  return (_options, callback) => {
    const request = new EventEmitter() as FakeRequest;
    request.destroy = () => {};
    request.end = () => {
      queueMicrotask(() => {
        const response = new PassThrough() as PassThrough & { statusCode?: number; headers?: Record<string, string> };
        response.statusCode = statusCode;
        response.headers = headers;
        callback(response as unknown as IncomingMessage);
        response.end(body);
      });
    };
    return request;
  };
}

describe('link preview fetcher', () => {
  it('uses fixed GET headers, ignores proxy environment variables and never stores/sends cookies', async () => {
    let targetRequests = 0;
    let proxyRequests = 0;
    const seen: IncomingMessage['headers'][] = [];
    const target = await startServer((request, response) => {
      targetRequests++;
      seen.push(request.headers);
      if (request.url === '/first') {
        response.writeHead(302, { location: '/final', 'set-cookie': 'session=from-site; HttpOnly' });
        response.end();
      } else {
        html(response);
      }
    });
    const proxy = await startServer((_request, response) => {
      proxyRequests++;
      response.writeHead(502);
      response.end('proxy should not be used');
    });
    vi.stubEnv('HTTP_PROXY', `http://127.0.0.1:${proxy.port}`);
    vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${proxy.port}`);
    vi.stubEnv('NO_PROXY', '');
    vi.stubEnv('TABULA_BASE_URL', 'https://tabula.app');
    vi.stubEnv('http_proxy', `http://127.0.0.1:${proxy.port}`);
    vi.stubEnv('https_proxy', `http://127.0.0.1:${proxy.port}`);
    vi.stubEnv('no_proxy', '');

    const result = await fetchPage(url(target.port, '/first'), {
      ...optionsFor(target.port),
      acceptLanguage: 'sv-SE,sv;q=0.9',
    });
    expect(result.finalUrl).toBe(url(target.port, '/final'));
    expect(targetRequests).toBe(2);
    expect(proxyRequests).toBe(0);
    for (const headers of seen) {
      expect(headers['user-agent']).toBe('TabulaLinkPreview/1.0 (+https://tabula.app/docs/link-previews)');
      expect(headers.accept).toBe('text/html,application/xhtml+xml;q=0.9');
      expect(headers['accept-encoding']).toBe('gzip, br');
      expect(headers['accept-language']).toBe('sv-SE');
      expect(headers.cookie).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
      expect(headers.referer).toBeUndefined();
      expect(headers.host).toBe(`preview.test:${target.port}`);
    }
  });

  it('follows relative redirects and allows an HTTPS-to-HTTP redirect, reporting the final URL', async () => {
    const target = await startServer((request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { location: './middle' });
        response.end();
      } else if (request.url === '/middle') {
        response.writeHead(302, { location: '/final' });
        response.end();
      } else {
        html(response, '<head><title>Final</title></head>');
      }
    });
    const result = await fetchPage(url(target.port, '/start'), optionsFor(target.port));
    expect(result.redirects).toBe(2);
    expect(result.finalUrl).toBe(url(target.port, '/final'));

    const tlsOptions: RequestOptions[] = [];
    let lookupCalls = 0;
    const requestImpl: RequestImpl = (requestOptions, callback) => {
      if (requestOptions.protocol === 'https:') {
        tlsOptions.push(requestOptions);
        return fakeResponseRequest(302, { location: url(target.port, '/final') })(requestOptions, callback) as FakeRequest;
      }
      return http.request(requestOptions as http.RequestOptions, callback);
    };
    const schemeResult = await fetchPage(`https://preview.test/secure`, {
      ...optionsFor(target.port, async () => {
        lookupCalls++;
        return [{ address: lookupCalls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
      }),
      requestImpl,
    });
    expect(schemeResult.finalUrl).toBe(url(target.port, '/final'));
    expect(schemeResult.redirects).toBe(1);
    expect(tlsOptions).toHaveLength(1);
    expect(tlsOptions[0]).toMatchObject({ servername: 'preview.test', rejectUnauthorized: true, autoSelectFamily: false });
  });

  it('uses the checked address for the socket lookup and reads a mocked response head', async () => {
    vi.stubEnv('TABULA_BASE_URL', 'https://tabula.app');
    let requestOptions: RequestOptions & { method?: string; headers?: Record<string, string>; lookup?: (host: string, options: object, callback: (...args: unknown[]) => void) => void } | undefined;
    const requestImpl: RequestImpl = (options, callback) => {
      requestOptions = options as typeof requestOptions;
      return fakeResponseRequest(200, { 'content-type': 'application/xhtml+xml; charset=utf-8' }, Buffer.from('<head><title>Mock</title></head><body>ignored</body>'))(options, callback) as FakeRequest;
    };
    const result = await fetchPage('https://fixture.example/', {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      requestImpl,
    });
    expect(result.bytes.toString()).toBe('<head><title>Mock</title></head>');
    expect(result.contentType).toBe('application/xhtml+xml');
    expect(requestOptions).toMatchObject({ method: 'GET', servername: 'fixture.example', rejectUnauthorized: true, autoSelectFamily: false, maxHeaderSize: 16 * 1024 });
    expect(requestOptions?.headers).toMatchObject({
      accept: 'text/html,application/xhtml+xml;q=0.9',
      'accept-encoding': 'gzip, br',
      'user-agent': 'TabulaLinkPreview/1.0 (+https://tabula.app/docs/link-previews)',
      'accept-language': 'en',
    });
    if (!requestOptions?.lookup) throw new Error('fetch request did not install its pinned lookup');
    const pinnedLookup = requestOptions.lookup;
    const resolved = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      pinnedLookup('fixture.example', {}, (error: unknown, address: unknown, family: unknown) => {
        if (error) reject(error);
        else resolve({ address: address as string, family: family as number });
      });
    });
    expect(resolved).toEqual({ address: '8.8.8.8', family: 4 });
  });

  it('ignores closing-head text in comments, raw text and quoted attributes', async () => {
    const body = '<head><!-- </head> --><script>const fake = "</head>";</script><div data-value="</head>"></div><meta name="description" content="kept"></head><body>ignored</body>';
    const requestImpl = fakeResponseRequest(200, { 'content-type': 'text/html' }, Buffer.from(body));
    const result = await fetchPage('https://fixture.example/', {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      requestImpl,
    });
    expect(result.bytes.toString()).toBe(body.slice(0, body.indexOf('<body>')));
  });

  it('times out while a mocked response keeps dripping bytes without closing the head', async () => {
    let dripTimer: ReturnType<typeof setInterval> | undefined;
    let response: (PassThrough & { statusCode?: number; headers?: Record<string, string> }) | undefined;
    const requestImpl: RequestImpl = (_options, callback) => {
      const request = new EventEmitter() as FakeRequest;
      request.destroy = () => {
        if (dripTimer) clearInterval(dripTimer);
        response?.destroy();
      };
      request.end = () => {
        queueMicrotask(() => {
          response = new PassThrough() as PassThrough & { statusCode?: number; headers?: Record<string, string> };
          response.statusCode = 200;
          response.headers = { 'content-type': 'text/html' };
          callback(response as unknown as IncomingMessage);
          response.write('<head>');
          dripTimer = setInterval(() => response?.write('x'), 10);
        });
      };
      return request;
    };
    await expect(fetchPage('https://fixture.example/', {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      requestImpl,
      timeoutMs: 80,
    })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('stops after three redirects and refuses private, file and other-port redirect targets', async () => {
    let fourthHop = 0;
    let threeRedirectFinal = 0;
    const chain = await startServer((request, response) => {
      if (request.url?.startsWith('/three/')) {
        const count = Number(request.url.match(/^\/three\/(\d+)$/)?.[1] ?? 0);
        if (count === 3) {
          threeRedirectFinal++;
          html(response);
        } else {
          response.writeHead(302, { location: `/three/${count + 1}` });
          response.end();
        }
        return;
      }
      const n = Number(request.url?.match(/^\/chain\/(\d+)$/)?.[1] ?? 0);
      if (n === 4) fourthHop++;
      response.writeHead(302, { location: `/chain/${n + 1}` });
      response.end();
    });
    const exactlyThree = await fetchPage(url(chain.port, '/three/0'), optionsFor(chain.port));
    expect(exactlyThree.redirects).toBe(3);
    expect(threeRedirectFinal).toBe(1);
    await expect(fetchPage(url(chain.port, '/chain/0'), optionsFor(chain.port))).rejects.toMatchObject({ code: 'http_status', status: 302 });
    expect(fourthHop).toBe(0);

    let secondHits = 0;
    const second = await startServer((_request, response) => {
      secondHits++;
      html(response);
    });
    const source = await startServer((request, response) => {
      const location = request.url === '/private'
        ? `http://127.0.0.1:${second.port}/`
        : request.url === '/file'
          ? 'file:///etc/passwd'
          : `http://preview.test:${second.port}/`;
      response.writeHead(302, { location });
      response.end();
    });
    await expect(fetchPage(url(source.port, '/private'), {
      ...optionsFor(source.port), allowedPorts: { http: [source.port, second.port], https: [443] },
    })).rejects.toMatchObject({ code: 'blocked' });
    await expect(fetchPage(url(source.port, '/file'), optionsFor(source.port))).rejects.toMatchObject({ code: 'blocked' });
    await expect(fetchPage(url(source.port, '/other-port'), optionsFor(source.port))).rejects.toMatchObject({ code: 'blocked' });
    expect(secondHits).toBe(0);
  });

  it('handles protocol-relative and user-info redirects, stops loops, and checks DNS on every hop', async () => {
    let finalHits = 0;
    let targetPort = 0;
    let secondPort = 0;
    const target = await startServer((request, response) => {
      if (request.url === '/protocol') {
        response.writeHead(302, { location: `//preview.test:${targetPort}/final` });
        response.end();
      } else if (request.url === '/userinfo') {
        response.writeHead(302, { location: `http://user:pass@preview.test:${targetPort}/final` });
        response.end();
      } else if (request.url === '/loop') {
        response.writeHead(302, { location: `/loop` });
        response.end();
      } else if (request.url === '/private-hop') {
        response.writeHead(302, { location: `http://second-hop.test:${secondPort}/` });
        response.end();
      } else {
        finalHits++;
        html(response);
      }
    });
    targetPort = target.port;
    secondPort = target.port;
    const protocol = await fetchPage(url(target.port, '/protocol'), optionsFor(target.port));
    expect(protocol.finalUrl).toBe(url(target.port, '/final'));
    await expect(fetchPage(url(target.port, '/userinfo'), optionsFor(target.port))).rejects.toMatchObject({ code: 'blocked' });
    await expect(fetchPage(url(target.port, '/loop'), optionsFor(target.port))).rejects.toMatchObject({ code: 'http_status', status: 302 });

    let lookupCalls = 0;
    await expect(fetchPage(url(target.port, '/private-hop'), {
      ...optionsFor(target.port, async () => {
        lookupCalls++;
        return [{ address: lookupCalls === 1 ? '127.0.0.1' : '10.0.0.1', family: 4 }];
      }),
    })).rejects.toMatchObject({ code: 'blocked' });
    expect(lookupCalls).toBe(2);
    expect(finalHits).toBe(1);
  });

  it('pins the first checked address so a second DNS answer cannot rebind the connection', async () => {
    let hits = 0;
    const target = await startServer((_request, response) => {
      hits++;
      html(response);
    });
    let resolverCalls = 0;
    const result = await fetchPage(`http://rebind.test:${target.port}/`, {
      ...optionsFor(target.port, async () => {
        resolverCalls++;
        return [{ address: resolverCalls === 1 ? '127.0.0.1' : '10.0.0.1', family: 4 }];
      }),
    });
    expect(result.contentType).toBe('text/html');
    expect(hits).toBe(1);
    expect(resolverCalls).toBe(1);
  });

  it('refuses a host with one injected-public and one private DNS answer', async () => {
    let hits = 0;
    const target = await startServer((_request, response) => {
      hits++;
      html(response);
    });
    await expect(fetchPage(`http://mixed.test:${target.port}/`, {
      ...optionsFor(target.port, async () => [
        { address: '127.0.0.1', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]),
    })).rejects.toMatchObject({ code: 'blocked' });
    expect(hits).toBe(0);
  });

  it('counts decoded bytes, rejects gzip bombs and stops at an actual closing head', async () => {
    const bomb = gzipSync(Buffer.alloc(LINK_PAGE_LIMIT + 32, 0x78));
    const target = await startServer((request, response) => {
      if (request.url === '/gzip') {
        response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        response.end(bomb);
      } else if (request.url === '/plain') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(Buffer.alloc(LINK_PAGE_LIMIT + 2, 0x78));
      } else if (request.url === '/script-close') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<head><script>const fake = "</head>";</script><meta name="description" content="kept"></head><body>ignored</body>');
      } else {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<head><title>Small</title></head>${'x'.repeat(LINK_PAGE_LIMIT + 100)}`);
      }
    });
    await expect(fetchPage(url(target.port, '/gzip'), optionsFor(target.port))).rejects.toMatchObject({ code: 'too_large' });
    await expect(fetchPage(url(target.port, '/plain'), optionsFor(target.port))).rejects.toMatchObject({ code: 'too_large' });
    const early = await fetchPage(url(target.port, '/head'), optionsFor(target.port));
    expect(early.bytes.toString()).toBe('<head><title>Small</title></head>');
    const withScript = await fetchPage(url(target.port, '/script-close'), optionsFor(target.port));
    expect(withScript.bytes.toString()).toContain('<meta name="description" content="kept"></head>');
    expect(withScript.bytes.toString()).not.toContain('ignored');
  });

  it('limits response headers to 16 KiB and reports overflow as unreachable', async () => {
    const target = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html', 'x-oversized': 'x'.repeat(17 * 1024) });
      response.end('<head></head>');
    });
    let maxHeaderSize: number | undefined;
    const requestImpl: RequestImpl = (options, callback) => {
      maxHeaderSize = options.maxHeaderSize;
      return http.request(options as http.RequestOptions, callback);
    };
    await expect(fetchPage(url(target.port), { ...optionsFor(target.port), requestImpl })).rejects.toMatchObject({ code: 'unreachable' });
    expect(maxHeaderSize).toBe(16 * 1024);
  });

  it('accepts one case-insensitive supported encoding and refuses stacked or unknown encodings as unreachable', async () => {
    const compressed = gzipSync(Buffer.from('<head><title>Compressed</title></head>'));
    const target = await startServer((request, response) => {
      const encoding = request.url === '/uppercase' ? 'GZIP' : request.url === '/stacked' ? 'gzip, br' : 'future-codec';
      response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': encoding });
      response.end(compressed);
    });
    const valid = await fetchPage(url(target.port, '/uppercase'), optionsFor(target.port));
    expect(valid.bytes.toString()).toBe('<head><title>Compressed</title></head>');
    await expect(fetchPage(url(target.port, '/stacked'), optionsFor(target.port))).rejects.toMatchObject({ code: 'unreachable' });
    await expect(fetchPage(url(target.port, '/unknown'), optionsFor(target.port))).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('rejects an incomplete response body whose Content-Length is larger than its bytes', async () => {
    const target = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html', 'content-length': '100' });
      // the server sends less than it promised and drops the connection, as a failing origin does
      response.write('<head>short', () => response.socket?.destroy());
    });
    await expect(fetchPage(url(target.port), optionsFor(target.port))).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('normalizes CRLF and spaces in request paths and blocks malformed hosts before the wire', async () => {
    const seen: { host: string; path: string }[] = [];
    const target = await startServer((request, response) => {
      seen.push({ host: request.headers.host ?? '', path: request.url ?? '' });
      html(response);
    });
    await fetchPage(url(target.port, '/line break\r\nheader: value'), optionsFor(target.port));
    expect(seen).toHaveLength(1);
    expect(seen[0].host).not.toMatch(/[\r\n ]/);
    expect(seen[0].path).not.toMatch(/[\r\n ]/);
    expect(seen[0].path).toContain('%20');

    let requestCalls = 0;
    const requestImpl: RequestImpl = (options, callback) => {
      requestCalls++;
      return fakeResponseRequest(200, { 'content-type': 'text/html' }, Buffer.from('<head></head>'))(options, callback) as FakeRequest;
    };
    await expect(fetchPage(`http://preview.test \r\n:${target.port}/`, { ...optionsFor(target.port), requestImpl })).rejects.toMatchObject({ code: 'blocked' });
    expect(requestCalls).toBe(0);
  });

  it('enforces the one-fetch deadline, HTML type and 2xx status rules', async () => {
    let dripTimer: ReturnType<typeof setInterval> | undefined;
    const target = await startServer((_request, response) => {
      if (_request.url === '/hang') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.write('<head>');
      } else if (_request.url === '/drip') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.write('<head>');
        dripTimer = setInterval(() => response.write('x'), 15);
        response.once('close', () => clearInterval(dripTimer));
      } else if (_request.url === '/image') {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(pngBytes());
      } else {
        response.writeHead(404, { 'content-type': 'text/html' });
        response.end('not found');
      }
    });
    await expect(fetchPage(url(target.port, '/hang'), { ...optionsFor(target.port), timeoutMs: 30 })).rejects.toMatchObject({ code: 'timeout' });
    await expect(fetchPage(url(target.port, '/drip'), { ...optionsFor(target.port), timeoutMs: 120 })).rejects.toMatchObject({ code: 'timeout' });
    await expect(fetchPage(url(target.port, '/image'), optionsFor(target.port))).rejects.toMatchObject({ code: 'not_html' });
    await expect(fetchPage(url(target.port, '/missing'), optionsFor(target.port))).rejects.toMatchObject({ code: 'http_status', status: 404 });
  });

  it('fetches image and icon bytes by magic type under their separate caps', async () => {
    const target = await startServer((request, response) => {
      if (request.url === '/icon-large') {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(pngBytes(LINK_ICON_LIMIT + 1));
      } else if (request.url === '/image-large') {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(pngBytes(LINK_IMAGE_LIMIT + 1));
      } else if (request.url === '/webp') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]));
      } else {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(pngBytes());
      }
    });
    const result = await fetchImages({ imageUrl: url(target.port, '/png'), iconUrl: url(target.port, '/webp') }, optionsFor(target.port));
    expect(result.image).toMatchObject({ type: 'image/png', size: 12 });
    expect(result.icon).toMatchObject({ type: 'image/webp', size: 16 });
    await expect(fetchImage(url(target.port, '/icon-large'), { ...optionsFor(target.port), kind: 'icon' })).rejects.toMatchObject({ code: 'too_large' });
    await expect(fetchImage(url(target.port, '/image-large'), optionsFor(target.port))).rejects.toMatchObject({ code: 'too_large' });
  });
});
