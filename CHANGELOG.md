# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- GitHub Actions CI: lint, typecheck and `npm audit` on Linux; tests and production build on a Linux/macOS/Windows × Node 22/24 matrix with npm caching; Docker image build with GitHub Actions layer cache, pushed to GHCR on `main` and `v*` tags; a single `CI passed` gate job for branch protection.
- Superseded runs are cancelled per branch/PR so rapid consecutive pushes only build the latest commit; docs-only pushes to `main` skip CI.
- CodeQL analysis (push, PR, weekly), dependency review on PRs, and Dependabot for npm, GitHub Actions and Docker.
- `npm run lint` using oxlint (`.oxlintrc.json`). typescript-eslint does not yet support TypeScript 7.
- `.gitattributes` normalising line endings to LF so Windows checkouts match.

### Changed
- Minimum Node version is now 22.12, which vitest 5 requires.
- Rewrote ternary/short-circuit expression statements in `src/app.ts` as `if` statements and simplified small lint findings in `src/mermaid.ts`, `src/markup.ts` and `test/core.test.ts`, with no change in behaviour.

### Removed
- `pnpm-lock.yaml`; npm (`package-lock.json`) is the single package manager, matching the Dockerfile.
