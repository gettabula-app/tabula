// Relay-side, single-hop-pinned HTTP fetching for link previews (docs/link-cards.md).
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { sniffType } from './image-header.mjs';
import { LinkGuardError, resolveAndCheck } from './link-guard.mjs';

export const LINK_PAGE_LIMIT = 1024 * 1024;
export const LINK_IMAGE_LIMIT = 2 * 1024 * 1024;
export const LINK_ICON_LIMIT = 256 * 1024;
export const LINK_TIMEOUT_MS = 5000;
export const LINK_LOOKUP_TIMEOUT_MS = 2000;
export const LINK_REDIRECT_LIMIT = 3;
export const LINK_PREVIEW_USER_AGENT = 'TabulaLinkPreview/1.0 (+https://tabula.app/docs/link-previews)';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export class LinkFetchError extends Error {
  constructor(code, message = code, status = undefined) {
    super(message);
    this.name = 'LinkFetchError';
    this.code = code;
    this.status = status;
  }
}

const fetchError = (code, message = code, status) => new LinkFetchError(code, message, status);

function makeDeadline(timeoutMs, parentSignal) {
  const controller = new AbortController();
  let timer;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  timer = setTimeout(() => controller.abort(new Error('Link preview deadline exceeded')), timeoutMs);
  return {
    signal: controller.signal,
    abort(reason = new Error('Link preview fetch failed')) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    close() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

function errorFrom(error, signal) {
  if (error instanceof LinkFetchError) return error;
  if (error instanceof LinkGuardError) return fetchError(error.code, error.message);
  if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'ETIMEDOUT') {
    return fetchError('timeout', 'Link preview deadline exceeded');
  }
  return fetchError('unreachable', 'The site could not be reached');
}

function requestLookup(address, family) {
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function userAgentFor(instanceUrl = process.env.TABULA_BASE_URL) {
  if (!instanceUrl) return LINK_PREVIEW_USER_AGENT;
  try {
    const base = new URL(instanceUrl);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return LINK_PREVIEW_USER_AGENT;
    return `TabulaLinkPreview/1.0 (+${base.origin}/docs/link-previews)`;
  } catch {
    return LINK_PREVIEW_USER_AGENT;
  }
}

function languageHeader(value) {
  const first = String(value ?? '').split(',')[0].trim().split(';')[0].trim();
  return /^[a-zA-Z0-9*-]{1,35}(?:-[a-zA-Z0-9]{1,8})*$/.test(first) ? first : 'en';
}

function requestForHop(url, pin, { signal, accept, acceptLanguage, instanceUrl, requestImpl }) {
  const secure = url.protocol === 'https:';
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const transport = secure ? https : http;
  const agent = secure
    ? new https.Agent({ keepAlive: false, maxSockets: 1, autoSelectFamily: false, rejectUnauthorized: true })
    : new http.Agent({ keepAlive: false, maxSockets: 1, autoSelectFamily: false });
  const headers = {
    accept,
    'accept-encoding': 'gzip, br',
    'user-agent': userAgentFor(instanceUrl),
    host: url.host,
  };
  if (acceptLanguage) headers['accept-language'] = languageHeader(acceptLanguage);

  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const requestOptions = {
      protocol: url.protocol,
      hostname: host,
      port: url.port ? Number(url.port) : undefined,
      method: 'GET',
      path: `${url.pathname || '/'}${url.search}`,
      headers,
      maxHeaderSize: 16 * 1024,
      lookup: requestLookup(pin.address, pin.family),
      autoSelectFamily: false,
      agent,
      signal,
      ...(secure ? { rejectUnauthorized: true, ...(isIP(host) ? {} : { servername: host }) } : {}),
    };
    const onResponse = (response) => {
      if (settled) {
        response.destroy();
        return;
      }
      settled = true;
      resolve({ request, response, agent });
    };
    try {
      request = requestImpl ? requestImpl(requestOptions, onResponse) : transport.request(requestOptions, onResponse);
    } catch (error) {
      agent.destroy();
      reject(error);
      return;
    }
    request.once('error', (error) => {
      if (settled) return;
      settled = true;
      agent.destroy();
      reject(error);
    });
    request.end();
  });
}

async function openResponse(input, {
  signal,
  lookup,
  isPublicAddress,
  denyList,
  allowedPorts,
  maxRedirects = LINK_REDIRECT_LIMIT,
  accept,
  acceptLanguage,
  instanceUrl,
  requestImpl,
} = {}) {
  let current;
  try {
    current = new URL(input);
  } catch {
    throw fetchError('blocked', 'Address is not allowed');
  }
  let redirects = 0;
  for (;;) {
    if (signal?.aborted) throw fetchError('timeout', 'Link preview deadline exceeded');
    let pin;
    try {
      pin = await resolveAndCheck(current.href, { lookup, isPublicAddress, denyList, allowedPorts, lookupTimeoutMs: LINK_LOOKUP_TIMEOUT_MS, signal });
    } catch (error) {
      throw errorFrom(error, signal);
    }

    let opened;
    try {
      opened = await requestForHop(current, pin, { signal, accept, acceptLanguage, instanceUrl, requestImpl });
    } catch (error) {
      throw errorFrom(error, signal);
    }

    const { response, request, agent } = opened;
    if (REDIRECTS.has(response.statusCode)) {
      const location = response.headers.location;
      response.destroy();
      agent.destroy();
      if (!location || redirects >= maxRedirects) throw fetchError('http_status', 'Too many or invalid redirects', response.statusCode);
      try {
        current = new URL(location, current);
      } catch {
        throw fetchError('blocked', 'Redirect address is not allowed');
      }
      redirects += 1;
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.destroy();
      agent.destroy();
      throw fetchError('http_status', 'The site returned an unsuccessful status', response.statusCode);
    }
    return { current, response, request, agent, redirects };
  }
}

function decodedBody(response) {
  const encoding = String(response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  if (!encoding || encoding === 'identity') return response;
  let decoder;
  if (encoding === 'gzip') decoder = createGunzip();
  else if (encoding === 'br') decoder = createBrotliDecompress();
  else if (encoding === 'deflate') decoder = createInflate();
  else throw fetchError('unreachable', 'The site used an unsupported content encoding');
  response.pipe(decoder);
  return decoder;
}

function headerEndScanner() {
  const rawTextElements = new Set(['script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
  let state = 'data';
  let tagName = '';
  let closing = false;
  let quote = 0;
  let rawName = '';
  let rawPattern = '';
  let rawMatched = 0;
  let rawCandidateComplete = false;
  let commentDashes = 0;
  let cdataBrackets = 0;
  let declarationQuote = 0;
  let declarationProbe = '';

  const lower = (byte) => byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
  const isSpace = (byte) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0c;
  const finishTag = (absolute) => {
    if (closing && tagName === 'head') return absolute + 1;
    if (!closing && rawTextElements.has(tagName)) {
      rawName = tagName;
      rawPattern = `</${rawName}`;
      rawMatched = 0;
      rawCandidateComplete = false;
      state = 'raw';
    } else {
      state = 'data';
    }
    tagName = '';
    closing = false;
    quote = 0;
    return null;
  };

  return (buffer, absoluteStart) => {
    for (let i = 0; i < buffer.length; i++) {
      const byte = buffer[i];
      const absolute = absoluteStart + i;
      if (state === 'raw') {
        if (rawCandidateComplete) {
          if (isSpace(byte) || byte === 0x2f || byte === 0x3e) {
            tagName = rawName;
            closing = true;
            state = 'tag-attrs';
            if (byte === 0x3e) {
              const end = finishTag(absolute);
              if (end !== null) return end;
            }
          } else {
            rawCandidateComplete = false;
            rawMatched = byte === 0x3c ? 1 : 0;
          }
          continue;
        }
        if (lower(byte) === rawPattern.charCodeAt(rawMatched)) rawMatched++;
        else rawMatched = byte === 0x3c ? 1 : 0;
        if (rawMatched === rawPattern.length) {
          rawCandidateComplete = true;
          rawMatched = 0;
        }
        continue;
      }

      if (state === 'comment') {
        if (byte === 0x2d) commentDashes = Math.min(2, commentDashes + 1);
        else if (byte === 0x3e && commentDashes === 2) {
          state = 'data';
          commentDashes = 0;
        } else commentDashes = 0;
        continue;
      }
      if (state === 'cdata') {
        if (byte === 0x5d) cdataBrackets = Math.min(2, cdataBrackets + 1);
        else if (byte === 0x3e && cdataBrackets === 2) {
          state = 'data';
          cdataBrackets = 0;
        } else cdataBrackets = 0;
        continue;
      }
      if (state === 'declaration-probe') {
        declarationProbe += String.fromCharCode(lower(byte));
        if (declarationProbe === '--') {
          state = 'comment';
          commentDashes = 0;
          declarationProbe = '';
        } else if (declarationProbe === '[cdata[') {
          state = 'cdata';
          cdataBrackets = 0;
          declarationProbe = '';
        } else if ('--'.startsWith(declarationProbe) || '[cdata['.startsWith(declarationProbe)) {
          continue;
        } else {
          state = 'declaration';
          declarationProbe = '';
          declarationQuote = 0;
          if (byte === 0x3e) state = 'data';
        }
        continue;
      }
      if (state === 'declaration') {
        if (declarationQuote) {
          if (byte === declarationQuote) declarationQuote = 0;
        } else if (byte === 0x22 || byte === 0x27) declarationQuote = byte;
        else if (byte === 0x3e) state = 'data';
        continue;
      }

      if (state === 'data') {
        if (byte === 0x3c) state = 'tag-open';
        continue;
      }
      if (state === 'tag-open') {
        if (byte === 0x2f) {
          closing = true;
          tagName = '';
          state = 'tag-name';
        } else if (byte === 0x21) {
          state = 'declaration-probe';
          declarationProbe = '';
        } else if (byte === 0x3f) {
          state = 'declaration';
          declarationQuote = 0;
        } else if ((lower(byte) >= 0x61 && lower(byte) <= 0x7a)) {
          closing = false;
          tagName = String.fromCharCode(lower(byte));
          state = 'tag-name';
        } else if (byte !== 0x3c) {
          state = 'data';
        }
        continue;
      }
      if (state === 'tag-name') {
        if (isSpace(byte) || byte === 0x2f) {
          state = 'tag-attrs';
        } else if (byte === 0x3e) {
          const end = finishTag(absolute);
          if (end !== null) return end;
        } else {
          tagName += String.fromCharCode(lower(byte));
        }
        continue;
      }
      if (state === 'tag-attrs') {
        if (quote) {
          if (byte === quote) quote = 0;
        } else if (byte === 0x22 || byte === 0x27) quote = byte;
        else if (byte === 0x3e) {
          const end = finishTag(absolute);
          if (end !== null) return end;
        }
      }
    }
    return null;
  };
}

function readCapped(response, request, agent, { limit, stopAtHead = false, signal }) {
  let output;
  try {
    output = decodedBody(response);
  } catch (error) {
    response.destroy();
    agent.destroy();
    throw error;
  }
  const chunks = [];
  const scanHead = stopAtHead ? headerEndScanner() : null;

  return new Promise((resolve, reject) => {
    let settled = false;
    let total = 0;
    const close = () => {
      output.once('error', () => {});
      response.once('error', () => {});
      if (output !== response) output.destroy();
      response.destroy();
      request.destroy();
      agent.destroy();
    };
    const finish = (fn, value, shouldClose = false) => {
      if (settled) return;
      settled = true;
      output.removeListener('data', onData);
      output.removeListener('end', onEnd);
      if (!shouldClose) {
        output.removeListener('error', onError);
        response.removeListener('aborted', onAborted);
      }
      signal?.removeEventListener('abort', onAbort);
      if (shouldClose) close();
      else agent.destroy();
      fn(value);
    };
    const tooLarge = () => finish(reject, fetchError('too_large', 'Response exceeded its decoded size limit'), true);
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const headEnd = scanHead?.(bytes, total) ?? null;
      if (headEnd !== null) {
        if (headEnd > limit) {
          tooLarge();
          return;
        }
        const keep = headEnd - total;
        if (keep > 0) chunks.push(bytes.subarray(0, keep));
        finish(resolve, Buffer.concat(chunks, headEnd), true);
        return;
      }
      if (total + bytes.length > limit || (stopAtHead && total + bytes.length >= limit)) {
        tooLarge();
        return;
      }
      total += bytes.length;
      chunks.push(bytes);
    };
    const onEnd = () => finish(resolve, Buffer.concat(chunks, total));
    const onError = (error) => finish(reject, errorFrom(error, signal), true);
    const onAborted = () => onError(new Error('Response ended before its body was complete'));
    const onAbort = () => finish(reject, fetchError('timeout', 'Link preview deadline exceeded'), true);
    output.on('data', onData);
    output.once('end', onEnd);
    output.once('error', onError);
    response.once('aborted', onAborted);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function contentType(response) {
  const raw = String(response.headers['content-type'] ?? '');
  const [mime, ...params] = raw.split(';');
  const charsetMatch = params.join(';').match(/(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i);
  return {
    mime: mime.trim().toLowerCase(),
    charset: charsetMatch?.[1] ?? charsetMatch?.[2] ?? charsetMatch?.[3] ?? null,
  };
}

/** Fetch and decode a page head. The caller passes `bytes` and `charset` to link-parse.mjs. */
export async function fetchPage(url, options = {}) {
  const deadline = makeDeadline(Math.min(options.timeoutMs ?? LINK_TIMEOUT_MS, LINK_TIMEOUT_MS), options.signal);
  try {
    const opened = await openResponse(url, {
      signal: deadline.signal,
      lookup: options.lookup,
      isPublicAddress: options.isPublicAddress,
      denyList: options.denyList,
      allowedPorts: options.allowedPorts,
      maxRedirects: Math.min(options.maxRedirects ?? LINK_REDIRECT_LIMIT, LINK_REDIRECT_LIMIT),
      accept: 'text/html,application/xhtml+xml;q=0.9',
      acceptLanguage: options.acceptLanguage ?? 'en',
      instanceUrl: options.instanceUrl,
      requestImpl: options.requestImpl,
    });
    const { mime, charset } = contentType(opened.response);
    if (mime !== 'text/html' && mime !== 'application/xhtml+xml') {
      opened.response.destroy();
      opened.agent.destroy();
      throw fetchError('not_html', 'Response is not an HTML page');
    }
    const bytes = await readCapped(opened.response, opened.request, opened.agent, {
      limit: Math.min(options.maxBytes ?? LINK_PAGE_LIMIT, LINK_PAGE_LIMIT),
      stopAtHead: true,
      signal: deadline.signal,
    });
    return {
      bytes,
      charset,
      contentType: mime,
      finalUrl: opened.current.href,
      redirects: opened.redirects,
    };
  } catch (error) {
    throw errorFrom(error, deadline.signal);
  } finally {
    deadline.close();
  }
}

async function fetchImageOnDeadline(url, options, signal) {
  const isIcon = options.kind === 'icon';
  const opened = await openResponse(url, {
    signal,
    lookup: options.lookup,
    isPublicAddress: options.isPublicAddress,
    denyList: options.denyList,
    allowedPorts: options.allowedPorts,
    maxRedirects: Math.min(options.maxRedirects ?? LINK_REDIRECT_LIMIT, LINK_REDIRECT_LIMIT),
    accept: 'image/png,image/jpeg,image/gif,image/webp',
    instanceUrl: options.instanceUrl,
    requestImpl: options.requestImpl,
  });
  const maxBytes = Math.min(options.maxBytes ?? (isIcon ? LINK_ICON_LIMIT : LINK_IMAGE_LIMIT), isIcon ? LINK_ICON_LIMIT : LINK_IMAGE_LIMIT);
  const bytes = await readCapped(opened.response, opened.request, opened.agent, { limit: maxBytes, signal });
  const type = sniffType(bytes);
  if (!type) return null; // SVG, ICO, HTML errors and malformed image bodies are skipped.
  return { bytes, type, size: bytes.length, finalUrl: opened.current.href, redirects: opened.redirects };
}

/** Fetch one PNG/JPEG/GIF/WebP by magic bytes; icons default to 256 KB and preview images to 2 MB. */
export async function fetchImage(url, options = {}) {
  const deadline = makeDeadline(Math.min(options.timeoutMs ?? LINK_TIMEOUT_MS, LINK_TIMEOUT_MS), options.signal);
  try {
    return await fetchImageOnDeadline(url, options, deadline.signal);
  } catch (error) {
    deadline.abort(error);
    throw errorFrom(error, deadline.signal);
  } finally {
    deadline.close();
  }
}

/** Fetch an image and an icon concurrently under one shared five-second deadline. */
export async function fetchImages({ imageUrl, iconUrl }, options = {}) {
  const deadline = makeDeadline(Math.min(options.timeoutMs ?? LINK_TIMEOUT_MS, LINK_TIMEOUT_MS), options.signal);
  try {
    const [image, icon] = await Promise.all([
      imageUrl ? fetchImageOnDeadline(imageUrl, { ...options, kind: 'image' }, deadline.signal) : null,
      iconUrl ? fetchImageOnDeadline(iconUrl, { ...options, kind: 'icon' }, deadline.signal) : null,
    ]);
    return { image, icon };
  } catch (error) {
    deadline.abort(error);
    throw errorFrom(error, deadline.signal);
  } finally {
    deadline.close();
  }
}
