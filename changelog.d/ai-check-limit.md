section: Changed

- `npm run check:ai-review` no longer runs into the open-mode limit of 20 AI runs an hour per client address: its throwaway relay trusts `x-forwarded-for` and each browser context sends its own address, so several themes or repeated checks work in one hour. Nothing changes in the relay's own limits. `npm run visual` starts no AI run (its AI states hand the page a relay message), so it was never affected.
