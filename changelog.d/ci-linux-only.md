section: Changed
audience: dev

- CI: every push and pull request tests on Linux only (Node 24 with the browser tests, and Node 26); the full Linux, macOS and Windows matrix runs for a release, on request and every night. CodeQL runs on pull requests, nightly and on request instead of on every push.
