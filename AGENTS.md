# AGENTS.md: rules for all agents (Claude and Codex) in this repo

## Where you work
There are two kinds of worktree, each in its own folder under `/Volumes/External/tabula/`:

| Kind | Location | Branch | Lifetime |
|---|---|---|---|
| Task worktree: a change that goes to main | `wt/<agent>-<task>` | any branch name | until merged, then removed |
| Prototype or scratch pad: preview, experiment, QA harness, drafts | `proto/<agent>-<name>` | `proto/<name>` | until its owner retires it |

- Work ONLY in a worktree of one of those two kinds, outside every main checkout. Nothing under `.claude/worktrees`, `/private/tmp`, `/var/folders`, or the root of `/Volumes/External/tabula`, and never inside a repo folder. Create no other folders in `/Volumes/External/tabula`.
- Every worktree has a branch. No detached worktrees: removing one loses its commits.
- Never edit the main checkout (`/Volumes/External/tabula/tabula`).
- First command of every job: `git rev-parse --show-toplevel`. If it is not your worktree, STOP and report.
- Use relative paths only, in shell commands and in apply_patch. Never write an absolute path (a dropped path segment once wrote into the main checkout).
- The orchestrating agent checks `git -C /Volumes/External/tabula/tabula status --short` after every job.

## What you may do
- Codex: leave your changes UNCOMMITTED. The sandbox cannot write the git metadata of a linked worktree; the orchestrating agent reviews the diff and commits.
- No push, no deploy, no release, no secrets, no `.env` files, no `pkill` by name (stop only PIDs you started).
- Start every `codex exec` with `</dev/null` (otherwise it waits for stdin and hangs) and detach long jobs.

## Gates before you call a change done
- `npx tsc --noEmit`, `npm run lint`, `npm run changelog:check` (add `changelog.d/<id>.md`, never edit CHANGELOG.md), and the full `npm test` (vitest).
- Timing- or Windows-sensitive change: also `npm run test:repeat -- <files> --times 15 --platform win32`.
- Write tests the way `docs/testing.md` says (barriers, polling, injected clocks, lower bounds only).

## Prototypes
Prototypes explore an idea or give someone something to look at. They never merge as they are.
1. Create `proto/<agent>-<name>` off current main on a `proto/<name>` branch, and add a row to `proto/README.md` (outside the repo, next to `wt/`): name, owner, purpose, branch, created, review-by date (default 7 days), and the port of any dev server.
2. Run dev servers on fixed ports: designer previews from 5400, QA scripts from 5500, everyone else from 5600. Throwaway servers started by a script stop in its `finally` block.
3. The reviewer (Johan or the manager) decides: promote, iterate or retire. Write the outcome in the register row.
4. To promote, make a NEW task worktree off current main, port the change with its tests and changelog fragment, and run the gates. Do not merge the prototype branch.
5. To retire: stop the servers you started (by PID), commit anything worth keeping to the prototype branch (a WIP commit with explicit paths, never `git add -A`), remove the worktree, delete the register row.

At the review-by date the owner extends it (one line in the register) or retires the prototype. Translation drafts that will go to main after review are task worktrees, not prototypes.

## When a worktree is done
- **Merged task worktree:** the owner removes it within one standup cycle (about 20 minutes) of the merge, without waiting for the manager: `git -C /Volumes/External/tabula/tabula worktree remove /Volumes/External/tabula/wt/<agent>-<task>` (no `--force`, never `rm -rf`), then `git worktree prune`. That removes the `node_modules` inside it too (each worktree has its own, and they fill the disk). Keep the branch; delete it only when the manager says so. A worktree still named in the manager's queue, or holding changes you still want, is not removed: say so instead.
- **Uncommitted files:** commit them to the branch as a WIP commit (explicit paths) before removing. Never discard another agent's uncommitted work.
- **Unmerged task worktree with no activity for 24 hours:** commit WIP to its branch and remove the worktree, or say why it stays.
- **Dev servers:** stop what you started (by PID) when you remove the worktree. The manager may stop any server older than 24 hours that is not in the prototype register.

## Deploys: only what is pushed
Johan's rule (2026-10-11): we only deploy when pushing. Production must never run code that exists only on one machine.
- Deploy (fly deploy, vercel deploy, an image build that gets registered as a release) only from a clean checkout whose commit is already on `origin/main`: `git fetch`, `git status --short` empty, and `git merge-base --is-ancestor HEAD origin/main` succeeds. Never from a feature branch, a detached local commit, or a dirty tree.
- A change that must ship is pushed (after review and its gates) before it is deployed. Push first, deploy second, never the other way round.
- Every deploy still needs Johan's explicit go for that deploy. A go to push is not a go to deploy.
- `tabula-cloud` deploys go through `scripts/deploy-guard.sh` (it refuses when the rules above do not hold). Image builds and site deploys follow the same checks by hand until they have a guard.

## Customer-facing text
Anything a customer can read (site, app strings, emails, docs, press, changelog, store listings) follows the positioning brief and `business/positioning-brief.md`'s claims rules:
- Every claim has a source line (a test, a doc page, a measured number). No claim about a feature that is behind a flag, in a spec or "not built yet". Current holds: AI credits, backups add-on, SSO, presentation mode, join codes, native apps.
- Never name a competitor, anywhere. No "cheapest", no uptime figures, no "EU-only", no numbers as promises (write what the user will see happen, for example "we email you a sign-in link when it is ready").
- Plain words, short sentences, Swedish in du-form. No "CRDT", "local-first" or "MCP" in headlines.
- Web app only: Windows, macOS desktop, iPhone and Android work is frozen (Johan, 11 Oct). Copy says "no app to install"; it never promises an app.
- Nothing customer-facing ships without Johan's go. The CGO reviews the text first; the manager takes it to Johan.

## Telemetry rule
Telemetry carries no identifier of a person: no user id, session id, email or hash of one, and nothing from inside a board. Events are keyed to the workspace or instance id only; device class is a count. The schema test enforces this; a change that adds a person-level field is refused in review, because it changes the legal basis (see `business/legal/telemetry-draft.md`). Self-hosted instances send nothing unless `TABULA_TELEMETRY=on`, and then only to our collector.

## Direction (Johan, 11 Oct 2026)
Agents are becoming the main users of software, and features can be copied quickly. We therefore:
- treat the MCP server and published skills as a product: typed, documented, with evaluations that build a board and check it against the rules;
- prefer objects with meaning over positioned shapes: typed cards (owner, status), decision objects, data tables (TAB-186), and a stable link to every object;
- document the board format publicly so agents can read it and customers can leave with it;
- design our own interface; we do not copy another product's interface, assets, text or brand, and we do not automate against other products' apps.
What we sell is running it, trust, help and taste, not the feature list; engineering choices that make those stronger come first.

## Who audits
The manager audits worktrees once a day: anything not in the prototype register and not in the queue gets a question to its owner, and the count goes to Johan. Only Johan decides a force-removal, or what to do with uncommitted work nobody claims.
