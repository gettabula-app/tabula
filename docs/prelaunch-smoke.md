# Tabula pre-launch smoke checklist

**Launch date:** Thursday 15 October 2026
**Product:** Tabula whiteboard
**Mail sender:** `no-reply@mg.gettabula.app`

Run the read-only checks from the Tabula repo after the site, API and demo are deployed. The default run checks the site, demo, education copy, legal pages and hosted API. It does not submit signup. The output includes one `PASS`, `FAIL` or `SKIP` per check and a summary; any `FAIL` exits non-zero.

```sh
npm run qa:prelaunch
```

Override the base URLs or choose stages when working against a preview or local fixture:

```sh
npm run qa:prelaunch -- --site https://gettabula.app --api https://api.gettabula.app
npm run qa:prelaunch -- --stage site,education,legal
npm run qa:prelaunch -- --stage demo --demo http://127.0.0.1:4173/demo/
npm run qa:prelaunch -- --stage all
```

`all` includes the signup stage, but that stage stays manual unless both `--yes-test-mode` and a `--stripe-url` on `checkout.stripe.com` containing `cs_test_` are supplied. It also needs a team-controlled `--email` and a new `--slug`. When enabled, the checklist starts `scripts/e2e-hosted.mjs --stage signup --plan flat`; that script creates a fresh test Checkout and checks that its actual URL and Stripe badge are in test mode before it enters the test card. Do not use a real card. Each successful signup provisions a test workspace that the manager/operator must tear down.

The education page check looks for the half-price offer and its application instructions during the trial. Terms and privacy are read from the published pages; local draft files are not substituted for a deployed page.

## Automated checks

| Check | Command | Expected |
| --- | --- | --- |
| Marketing routes: landing, signup/pricing, contact and docs | `npm run qa:prelaunch -- --stage site` | HTTP 200 after any redirects; no redirect loop; page URLs and any declared canonical use the configured host; every page has a title and meta description; no `localhost`, `127.0.0.1`, `example.com` or `TODO` in page text. |
| Canonical host and TLS | `npm run qa:prelaunch -- --stage site` | `www` redirects to the canonical host. The site certificate is currently valid and its remaining days are reported. Local HTTP fixtures show TLS and `www` as `SKIP`. |
| Robots, sitemap and sitemap pages | `npm run qa:prelaunch -- --stage site` | `robots.txt` allows `/` and names the canonical sitemap; the sitemap parses; every listed URL uses the canonical host, returns 200, and has a title and meta description. |
| Main-page internal links and images | `npm run qa:prelaunch -- --stage site` | Each same-origin link and image on the selected main pages returns HTTP 200. The Open Graph and Twitter card images exist and have an image content type. |
| Site and API security headers | `npm run qa:prelaunch -- --stage site,api` | Both hosts send HSTS, `X-Content-Type-Options: nosniff`, and either `X-Frame-Options` or a CSP `frame-ancestors` rule. |
| Flat-plan prices | `npm run qa:prelaunch -- --stage site` | Signup/pricing shows €29 monthly and €290 yearly per workspace, with no per-person or per-seat price; founding price is €19 for 12 months through 31 December 2026. |
| Education offer | `npm run qa:prelaunch -- --stage education` | The page says half price and tells a school/non-profit how to request the discount during its trial, before the first payment. |
| Legal placeholders | `npm run qa:prelaunch -- --stage legal` | `/terms` and `/privacy` return 200, have page metadata, and contain none of `TODO`, `lorem`, `[`, or `XXX`. |
| Landing-page demo | `npm run build:demo` then `npm run qa:prelaunch -- --stage demo` | Chromium loads the deployed `/demo/` at 1280 and 390 px, adds two sticky notes at each width, has no console errors, and has no failed request except the documented Fontshare hosts. Use `--demo http://127.0.0.1:4173/demo/` when a local fixture is available. |
| Hosted API health | `npm run qa:prelaunch -- --stage api` | `GET /api/health` returns HTTP 200 JSON with `ok: true`. This is the public health route documented by `server/relay.mjs` and `docs/cloud.md`. |
| Internal stats privacy | `npm run qa:prelaunch -- --stage api` | `GET /api/internal/stats` without a token returns 401 or 404. The script never reads or prints the response body. |
| Signup automation guard | `npm run qa:prelaunch -- --stage signup` | Without the test-mode flags, the stage prints manual steps and starts no checkout. With the flags, the existing hosted e2e must itself observe a `cs_test_` URL and Stripe test badge. |

Stages are `site`, `demo`, `signup`, `education`, `legal`, `api`, or `all`. The default is `site,demo,education,legal,api`. The checklist is intentionally separate from `npm test` and CI.

## Manual checks

Record evidence or a short note for each item. Leave the owner blank until the launch lead assigns it.

| Check | Expected | Owner |
| --- | --- | --- |
| Quick pass on a real iPad and iPhone | Open the site, signup page, demo and a signed-in workspace board; check layout, navigation, touch and no blocking errors. |  |
| Quick pass on a real Android phone | Open the site, signup page, demo and a signed-in workspace board; check layout, navigation, touch and no blocking errors. |  |
| Hosted signup end to end in Stripe TEST mode | Use the team mailbox plus-address and a new dated `e2e-` slug; finish with the test card only; the workspace becomes reachable and the welcome/sign-in mail arrives from `no-reply@mg.gettabula.app`. Confirm the mailbox and teardown with the manager. |  |
| Cancel and customer portal | Confirm Manage billing opens the Stripe portal, cancellation returns to the site, and the subscription/workspace are removed by the operator after the check. |  |
| Education coupon at checkout | Ask for the school/non-profit offer during the trial and confirm the 50 percent discount is applied before the first payment; confirm the founding and education discounts do not stack. |  |
| Demo on a phone | Add two notes, pan and zoom, open the banner link, and confirm the demo still resets on reload. |  |
| Terms and privacy read by a person | Read both pages for legal accuracy, current domains, price/trial/refund wording, processor details and contact information; record counsel/manager sign-off. |  |
| Plausible/PostHog and consent banner | Confirm the analytics property is the launch one, the displayed consent choice works as intended, and the privacy wording matches the deployed behaviour. |  |
| Backup status | Confirm the latest backup succeeded, retention and restore access are known, and a recent restore check is recorded. |  |
| On-call coverage | Name the launch-day primary and backup, confirm how to reach them, and agree who can execute rollback. |  |

## Rollback

The repo documents tagged workspace-image releases and says the control plane rolls workspaces onto registered releases. `docs/cloud.md` documents setting `TABULA_SOURCE_POLICY=off` and restarting a workspace only to recover from that specific source-policy lockout. It does not document how to disable or roll back the marketing site or hosted API, or a general workspace rollback. **TODO: ask the manager for the verified site/API takedown and rollback steps, workspace rollback authority, and the person who will execute them.**

## Go / no-go

- [ ] **GO** — all required automated checks pass, manual checks have evidence and owners, legal text is approved, backups and on-call are confirmed, and rollback steps are known.
- [ ] **NO-GO** — any launch blocker remains or a required owner/sign-off is missing.

**Decision owner:** ____________________  **Date/time:** ____________________
