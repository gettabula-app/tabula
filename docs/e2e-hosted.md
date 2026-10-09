# Hosted product: end-to-end test script

What a tester does to prove that the whole hosted path works: the landing site, signup, Stripe test checkout, the workspace, the sign-in mail and a board. Run it when the landing site is deployed, and again after any change to the site, the control plane, the edge, the mail relay or provisioning.

Facts here come from `tabula-cloud/docs/spec.md` and `first-deploy.md`, and from the manager's answers of 2026-10-09 where the domains changed. The tabula-cloud docs on `main` still say `gettabula.app` for workspaces; the updated ones are on its local `deploy/first-deploy` branch and are not pushed yet.

## Rules for every run

- **Stripe test mode only.** The only card is `4242 4242 4242 4242`, any future expiry, any CVC, any postcode. Never type a real card or real payment details anywhere, not even to see an error.
- **Each real signup creates a Fly app** (`tabula-ws-<slug>`) with a volume and costs money until it is torn down. Ask the manager before each one, say which test it is for, and tear it down afterwards (below). Tests that stop before checkout create nothing on Fly.
- Use a mailbox the team controls for the owner email, with a plus address per run (`name+e2e-0412a@…`), and a slug that starts with `e2e-` and carries the date, so leftovers are easy to find and delete. Never reuse a slug: a deleted one is reserved for 90 days.
- No secrets in notes, screenshots or issues. Do not paste the sign-in link or token; say "link received" and the time.
- Tools: a headless browser for the pages (screenshots to `tabula-review/e2e/<run>/`, not committed), the Stripe dashboard in test mode (read only, by the manager), and the control plane's operator API only through the manager.
- File a Linear bug (label `mira-b5`) for each defect with the step number, the exact text on screen, the time, and the screenshot path.

## Addresses

| Name | Value |
| --- | --- |
| `SITE` (landing site) | `https://gettabula.app` |
| `API` (control plane, public listener) | `https://api.gettabula.app` |
| `WS` (a workspace) | `https://<slug>.thetabula.cloud` |
| Mail sender | `no-reply@mg.gettabula.app` |
| Checkout success | `https://gettabula.app/signup/success?slug=<slug>` |
| Checkout cancel | `https://gettabula.app/signup?checkout=canceled` |

The checkout URLs go live after the next control-plane deploy. Until then Checkout still returns to the workspace address; note which it does and do not file it as a bug.

The site's form posts to `POST API/v1/signup` with `{email, workspaceName, slug, region, interval?, seats?}` and asks `GET API/v1/slugs/<slug>` while you type. Its fields are workspace name, an editable slug, email, plan (month or year), seats (with a minimum) and region (eu or us). Confirm the exact labels with designer once the site is up. The sign-in mail goes to the owner email used at signup.

## Before T1: smoke the site

Run the headless smoke of `SITE` first (`/`, `/signup`, `/docs`, `/privacy` at 1280 and 390 px; type slugs in the form but do not submit). Check there are no console errors or failed requests, in particular no CORS error on the live slug check (TAB-235: the control plane has to answer `OPTIONS` and send `Access-Control-Allow-Origin: https://gettabula.app` on `/v1/signup` and `/v1/slugs/*`). If the slug check shows "We could not check the address just now" for a free slug, stop and report: the signup post will fail the same way.

## T1. Happy path

Needs permission to create one workspace.

1. Open `SITE` at 1280 px wide. Check: the page loads over https, has one clear sign-up action, prices and the 7-day trial are stated, no console errors, no failed requests.
2. Choose the sign-up action. Check: the form asks for workspace name, an editable slug, email, plan (month or year), seats and region (eu or us). Seats start at the plan's minimum (2 at the time of writing; pricing and the minimum may change) and cannot go below it, and the page, the form and Checkout agree on that number. Typing a workspace name proposes a slug that you can edit.
3. Type the slug slowly. Check: the form tells you live whether it is free (it asks `GET /v1/slugs/:slug`), and the message names the rule when it is not.
4. Fill in: owner email, workspace name, slug `e2e-<date>`, region EU. Submit. Check: you go to a Stripe Checkout page (a `checkout.stripe.com` address in test mode, with the test-mode badge), not an error. The page shows a 7-day trial, the seat quantity and the amount due now (0 for the trial).
5. Pay with the test card. Check: Checkout returns you to `SITE/signup/success?slug=<slug>` (before the next control-plane deploy: to `WS/`), a page that says the workspace is being set up, not a blank page or an error.
6. The workspace takes a moment to provision. Check: the visitor sees something sensible while it is not ready (the success page's message, never a raw error or a certificate warning), the link from that page to `WS/` works, and within 5 minutes `WS/` shows the sign-in page.
7. Sign in with the owner email. Check: the mail arrives within 2 minutes, comes from `no-reply@mg.gettabula.app`, its link points at `WS`, and its text names the workspace. Open the link in the same browser. Check: you land on the boards page as the owner.
8. Create a board, add a sticky note, a shape and a comment, reload. Check: all of it is still there. Open the board in a second browser profile after inviting a second test address; check that both people see each other's cursor and edits.
9. Open **Admin**. Check: Overview shows 1 member and the board; the trial banner says when the trial ends; Backups tab loads.
10. Tear down (ask the manager): they cancel the subscription and delete the workspace through the operator API; check that `WS/` then shows the suspended or not-found page and that Stripe shows the subscription canceled.

Pass when every check holds and no step needed more than the 5-minute wait.

## T2. A taken slug

No permission needed for the first two steps; none creates a Fly app.

1. In the form, type the slug of a workspace that exists (the one from T1 while it is alive, or `www`, `app`, `admin`).
2. Check: the live check says it is unavailable and why ("taken" or "reserved"), and the submit is blocked or answers with that message. Nothing is charged and no Checkout opens.
3. Also try: 2 characters, 33 characters, capital letters, a leading hyphen, a trailing hyphen, spaces, `é`, `a_b`. Check each is refused with a message that names the rule (3 to 32 characters, lowercase letters, digits and hyphens, no leading or trailing hyphen).
4. Race: open the form in two tabs, enter the same free slug in both, submit the first and reach Checkout, then submit the second. Check: the second is refused as taken (a slug held by a `pending_checkout` workspace counts as taken), with no stack trace.

## T3. An invalid email

1. Submit with an empty email, `abc`, `abc@`, `a b@c.d` and a 300-character address. Check: each is refused next to the field, the page keeps what else you typed, and no request creates a customer (nothing appears in Stripe).
2. Submit `name+tag@example.com`. Check: accepted (plus addresses are valid).
3. Rate limit: submit the same valid form six times in a minute with a free slug each time but stop before paying. Check: at some point the answer is a calm "try again later" (the endpoint is limited per IP and per email), never a crash. Abandoned attempts leave `pending_checkout` rows that expire by themselves; tell the manager how many you made.

## T4. A cancelled checkout

Needs no Fly app, because provisioning starts only after payment.

1. Start a signup as in T1 up to the Stripe Checkout page.
2. Use Checkout's back link. Check: you return to `SITE/signup?checkout=canceled` (before the next control-plane deploy, wherever Checkout sends you), the page says the checkout was cancelled and nothing was charged, and the form is usable again with a clear way to retry.
3. Retry with the same slug straight away. Check: either it works (the slug is free again) or the message says it is being held and for how long. Record which. Expected from the spec: a pending checkout is released when Stripe sends `checkout.session.expired` or after 24 hours.
4. Close the Checkout tab without paying, wait, and check that `WS/` does not exist (the not-found or "workspace not found" page, not a half-built workspace).

A declined card is not tested here: the only card allowed is `4242 4242 4242 4242`.

## T5. Phone layout

Run T1 steps 1 to 4 and T2 step 1 at 360 and 390 px wide in a mobile emulation, then the workspace pages after sign-in.

1. Site: no sideways scroll, the sign-up action reachable without zooming, text at least 16 px in the form fields (iOS zooms smaller fields), tap targets at least 44 px, the keyboard does not hide the submit button.
2. Form errors from T2 and T3 stay visible next to the field on a phone.
3. Checkout is Stripe's page: only note whether the return to the site works.
4. Workspace after sign-in: the boards page and a board at 390 px, the chat and comments trays, the AI bar if enabled (it appears only with `?aibar` for now).
5. Take the five themes only for the workspace, not for the site.

## T6. Smaller checks to add once the main path passes

- The suspended page: a workspace whose subscription was canceled shows the suspended page with a **Restart subscription** button, and the restart mail link works once and then says it is no longer valid.
- `www` and the bare domain do not serve a workspace; unknown slugs show a not-found page without naming internals.
- Sign-in mail: a wrong email address on the sign-in page gets the same answer as a right one (no account enumeration).
- A second owner email cannot claim the workspace by signing in.
- The trial banner and, near the end of a trial, the trial-ending mail to the owner.

## Report

After a run, send the manager: which tests passed or failed, the Linear issues filed, the slugs created (for teardown), the time from payment to a reachable workspace, and the time from sign-in request to mail.
