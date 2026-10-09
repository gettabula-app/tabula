# Landing-page demo

Build the ephemeral static site with `npm run build:demo`. The result is written to `dist-demo/`; it is built for the absolute `/demo/` path and has no service worker, manifest, docs bundle, relay, account routes, browser persistence or image uploads. Board content and comments live in memory and disappear on reload unless exported. Board exports and Copy as Mermaid are available by choice. Imported board files are limited to 20 MiB, with ZIP expansion capped at 100 MiB. The demo uses a static allowlist of the nine built-in Fontshare families and never fetches the Fontshare catalogue; only allowlisted CSS and font files can load from Fontshare. PNG and SVG exports fetch fonts used on the board while exporting and inline the available WOFF2 files. An exported SVG makes no Fontshare request when opened. Combined raw font files are capped at 1.5 MB; if a font cannot be fetched or would exceed the cap, it uses a system fallback.

Publish `dist-demo/` under `/demo/` and embed it with:

```html
<iframe src="/demo/" title="Try Tabula" sandbox="allow-scripts allow-same-origin allow-downloads allow-top-navigation-by-user-activation"></iframe>
```

The page's Content Security Policy is emitted from `DEMO_CSP` in `vite.config.ts` and checked byte-for-byte by `scripts/check-demo-dist.mjs`. It uses `default-src 'none'` and `script-src 'self'`; inline styles are allowed for the app UI. Fontshare stylesheets are limited to `https://api.fontshare.com/v2/css`, font files to `https://cdn.fontshare.com`, and connections to that CSS endpoint plus the Fontshare CDN. Under CSP3, a path source without a trailing slash matches the exact `/v2/css` path, including its query string; the CDN source ending in `/` allows paths below that host. The source list has no wildcard or `unsafe-eval`.

```text
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://api.fontshare.com/v2/css; font-src https://cdn.fontshare.com; img-src 'self' data: blob:; connect-src 'self' https://api.fontshare.com/v2/css https://cdn.fontshare.com/; base-uri 'self'; form-action 'none'
```

The banner says “Demo: nothing is saved unless you export it. Reload and it resets.” on wide screens and shortens to “Demo: nothing is saved unless you export it.” on phones. Its “Make it yours →” link has `target="_top"`, `rel="noopener"` and points to `/#pricing`: it navigates the top page only when the iframe sandbox has `allow-top-navigation-by-user-activation` (a click is required). Without that token the browser blocks the navigation. Because `allow-scripts` and `allow-same-origin` together let the frame act as its own origin, the iframe is not sandboxed from that origin; the in-app guards in `src/demo.ts` and the Content Security Policy are the barriers. Hosting the demo on a separate origin is the stronger setup.
