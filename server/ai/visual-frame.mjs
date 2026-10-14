import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

export const VISUALIZATION_FRAME_PATH = '/api/ai/visual-frame';
export const VISUALIZATION_FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "connect-src 'none'",
  "font-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts',
].join('; ');

let frame;

function frameDocument() {
  if (frame) return frame;
  // The pinned browser package exposes its frame assembly method, but importing it in Node requires a browser global.
  // Evaluate only that installed, trusted bundle in a separate context to obtain its actual iframe bootstrap. Generated
  // content never reaches this context or this endpoint; the browser sends it to the opaque iframe after the handshake.
  const require = createRequire(import.meta.url);
  const context = { module: { exports: {} }, exports: {}, window: {}, self: {} };
  runInNewContext(readFileSync(require.resolve('@jetbrains/websandbox'), 'utf8'), context, { timeout: 1000 });
  const Websandbox = context.module.exports.default;
  frame = Buffer.from(Websandbox.prototype._prepareFrameContent({
    frameContent: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>',
  }));
  return frame;
}

/** A real document response gives the frame its own policy: srcdoc would inherit the app's script-src self. */
export function handleVisualizationFrame(req, res, pathname) {
  if (pathname !== VISUALIZATION_FRAME_PATH) return false;
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': VISUALIZATION_FRAME_CSP,
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=()',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...headers, allow: 'GET, HEAD' });
    res.end();
    return true;
  }
  const html = frameDocument();
  res.writeHead(200, { ...headers, 'content-length': html.length });
  res.end(req.method === 'HEAD' ? undefined : html);
  return true;
}
