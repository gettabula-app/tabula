section: Changed
audience: dev

- CI is Linux only everywhere: Node 24 (with the browser tests) and Node 26 on every push, plus Node 22 for a release and nightly; the macOS and Windows legs are gone. The four desktop test files are excluded from the default run (TABULA_DESKTOP_TESTS=1 runs them).
