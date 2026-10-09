# Landing-page demo

Build the ephemeral static site with `npm run build:demo`. The result is written to `dist-demo/`; it is built for the absolute `/demo/` path and has no service worker, manifest, docs bundle, relay, account routes, browser persistence or image uploads. Board content and comments live in memory and disappear on reload. Fontshare styles and font files are the only external requests.

Publish `dist-demo/` under `/demo/` and embed it with:

```html
<iframe src="/demo/" title="Try Tabula" sandbox="allow-scripts allow-same-origin allow-downloads allow-top-navigation-by-user-activation"></iframe>
```

The “Get Tabula” link has `target="_top"` and `rel="noopener"`: it navigates the top page only when the iframe sandbox has `allow-top-navigation-by-user-activation` (a click is required). Without that token the browser blocks the navigation. Because `allow-scripts` and `allow-same-origin` together let the frame act as its own origin, the iframe is not sandboxed from that origin; the in-app guards in `src/demo.ts` and the Content Security Policy are the barriers. Hosting the demo on a separate origin is the stronger setup.
