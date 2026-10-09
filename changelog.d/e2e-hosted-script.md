section: Added
audience: dev

- `node scripts/e2e-hosted.mjs` runs the end-to-end check of the hosted product in stages (site smoke and CORS, signup form rules, a cancelled Checkout, and the whole paid signup in Stripe test mode through the first sign-in and board). Stages that create anything need `--allow-checkout` or `--allow-signup`; it refuses to type a card unless Checkout shows the test-mode badge. `docs/e2e-hosted.md` describes the run.
