# Audit and review reports

Reports written by review agents (Codex workers) and the team on 10 to 11 October 2026. They are snapshots: each says which commit it reviewed, and its findings may have been fixed since. File and line references point to that commit, and some reports mention the temporary worktree they were written in. Use `git log` for the current state of the code before acting on a finding.

## In this folder

| Report | Task | What it covers |
|---|---|---|
| [dependency-audit.md](dependency-audit.md) | CDX-37 | Production dependencies, fonts, icons and art with their licences; AGPL compatibility; `npm audit`. Feeds `docs/third-party-notices.md` and the Fontshare decision. |
| [chat-default-on-audit.md](chat-default-on-audit.md) | CDX-31 | Chat enabled by default: first-run behaviour, limits, mention email, join-code guests, every place that reads `TABULA_CHAT`. |
| [chat-security-recheck.md](chat-security-recheck.md) | CDX-44 | First re-review of the chat privacy fix: account switch, cache scoping, history races. |
| [guide-check.md](guide-check.md) | CDX-38 | User guide: broken links, images and alt text, flag-gated features. |
| [large-board-perf.md](large-board-perf.md) | CDX-36 | Load, pan and zoom, drag and undo at 500, 2,000 and 5,000 objects, with five hotspot candidates. |
| [tracker-a11y-audit.md](tracker-a11y-audit.md) | CDX-30 | Tracker UI accessibility: keyboard, labels, tap targets, contrast. |

## Elsewhere in `docs/`

| Report | Task | What it covers |
|---|---|---|
| [../test-coverage-gaps.md](../test-coverage-gaps.md) | CDX-34 | Fifteen risk-ranked modules with weak or no tests. |
| [../chat-security-review.md](../chat-security-review.md) | CDX-35 | Security review of team chat. |
| [../chat-privacy-recheck.md](../chat-privacy-recheck.md) | CDX-49, CDX-50 | Second and third re-reviews of the chat privacy fix. |
| [../touch-audit.md](../touch-audit.md) | CDX-39 | Canvas touch audit with emulated phones. |
| [../accessibility-audit.md](../accessibility-audit.md) | | App-wide accessibility audit. |
| [../filter-grammar-bb.md](../filter-grammar-bb.md) | CDX-47, CDX-48 | Real-HTTP black-box run of the tracker filter grammar. |
| [../chat-api-flake.md](../chat-api-flake.md) | CDX-51 | The Windows connection-reset flake in the chat API test. |
