section: Added

- Use `changelog.d/` fragments for each change, then run `npm run changelog:fold` when merging to update `CHANGELOG.md`; `npm run changelog:check` validates the fragment format, and CI checks it. Contributors no longer edit `CHANGELOG.md` by hand for each change.
