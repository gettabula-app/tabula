# Releasing

TAB-236. A release is a `v*` tag. The release workflow (`.github/workflows/release.yml`) turns it into an image a hosted workspace can run: it runs the full CI gates, builds the Docker image with `TABULA_VERSION` set to the tag, pushes it to the Fly registry as `registry.fly.io/tabula-app:<tag>`, records the image's digest and, when it is set up for it, registers the release with the control plane. The control plane then rolls workspaces onto it (tabula-cloud, `docs/second-deploy.md` and its release notes; the data-safety rules are in [migrations.md](migrations.md)).

## Making a release

1. Be on a commit of `main` whose CI is green and whose changelog fragments are folded into `CHANGELOG.md` (`npm run changelog:fold`, run by the manager on main).
2. Tag it and push the tag: `git tag v4 && git push origin v4`. The label (`v4`) becomes the image tag and the `TABULA_VERSION` the server reports on `GET /api/internal/version`. It is 1 to 40 letters, digits, dots, dashes or underscores, for example `v4` or `2026.10.09-1`.
3. Watch the **Release** run. Its summary shows the image reference with its digest and the exact body that was (or would be) sent to the control plane.

By hand (a hotfix from a branch, or running a release again): Actions, **Release**, **Run workflow**, choose the branch or tag, give the label, and tick **security** for a security release and **register** to register it. A run from a branch builds that branch's code under the label you give, so use a label that says what it is.

## What the run does

1. **CI gates.** The same jobs as a pull request (lint, typecheck, audit, tests on Linux, macOS and Windows, the build, the Docker build): `ci.yml` is called as a reusable workflow, so there is one definition. A tag no longer starts CI by itself; the release run does, once. The Docker job still publishes the semver tags to ghcr.io as before.
2. **Build.** `docker build` with `--build-arg TABULA_VERSION=<tag>` (the Dockerfile already has the argument and puts it in the environment).
3. **Push**, only when `FLY_API_TOKEN` is set: `registry.fly.io/tabula-app:<tag>`. The digest of what was pushed is read from the build and printed.
4. **Register**, only when pushing, when **register** is on (the default) and `ADMIN_TOKEN` and `ADMIN_URL` are set: `POST $ADMIN_URL/admin/releases` with the body from `scripts/release-body.mjs` (image by digest, version, schema generations, highest reader generation and `security: true` when asked). This is the logic of tabula-cloud's `scripts/release.sh`, without needing that repository.

Without a secret the run **skips that step with a notice and still succeeds**: no `FLY_API_TOKEN` means the image is built (so the build is proven) but not pushed; no `ADMIN_TOKEN` or `ADMIN_URL` means it is pushed but not registered, and the run summary prints the command to register it by hand.

## What the repository owner sets

Settings, Secrets and variables, Actions:

| Name | Kind | Value |
| --- | --- | --- |
| `FLY_API_TOKEN` | secret | A Fly token that may push to `tabula-app`'s registry (a token scoped to that app is enough; an org token also works but is broader than needed; which kind Fly accepts for registry pushes is **unverified**, check on the first release). |
| `ADMIN_TOKEN` | secret | The control plane's `ADMIN_TOKEN`. |
| `ADMIN_URL` | secret or variable | The control plane's admin API, for example `http://127.0.0.1:8801` if you tunnel to it. |

**The admin API is not on the internet, on purpose** (tabula-cloud keeps `/admin` on an internal port that only operators reach, through `fly proxy 8801:8801 --app tabula-cloud` or WireGuard, and from the TAB-103 work on only from an allow-listed source address). A GitHub runner cannot reach it unless you give it a way in. So the dependable route is: let the workflow build and push, and register from an operator machine with the proxy running:

```
scripts/release.sh <tag> <digest> <path to this repository> --register [--security]
```

(`scripts/release.sh` is in tabula-cloud; the digest is in the run summary.) Setting `ADMIN_URL` is for a runner that can reach the admin API some other way, for example an authenticated tunnel step you add; the secrets are only read by the steps that need them and never printed.

## Checking a release

- The run summary shows the digest. `fly image show --app tabula-app` should list what the registry holds **(unverified)**.
- After registering, `GET /admin/releases` (through the operator proxy) lists it with its version, schema, reader generations and the security flag.
- A workspace that has been rolled onto it reports the label on `GET /api/internal/version`.

## What is not done

The run does not tag, does not fold the changelog, does not roll any workspace (that is a control-plane action with its own safeguards), and does not create a GitHub release page. No secret is needed to read this repository; the three above are the only ones the workflow uses.
