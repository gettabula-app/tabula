# Landing-page demo

Build the ephemeral static site with `npm run build:demo`. The result is written to `dist-demo/`; it is built for the absolute `/demo/` path and has no service worker, manifest, docs bundle, relay, account routes, browser persistence or image uploads. Board content and comments live in memory and disappear on reload. Fontshare styles and font files are the only external requests.

Publish `dist-demo/` under `/demo/` and embed it with:

```html
<iframe src="/demo/" title="Try Tabula" sandbox="allow-scripts allow-same-origin allow-downloads"></iframe>
```

The “Get Tabula” link navigates the iframe itself. Add `allow-top-navigation-by-user-activation` to the sandbox only if that link should navigate the top page.
