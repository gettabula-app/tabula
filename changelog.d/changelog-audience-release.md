section: Added
audience: dev

- `npm run changelog:fold -- --release <version>` (TAB-219) cuts a release: the folded entries and the old Unreleased content go under `## [<version>] - <YYYY-MM-DD>` and an empty Unreleased stays on top. A fragment may carry `audience: user|dev` (default `user`); fold keeps it as an audience marker (an HTML comment) at the end of a `dev` bullet so a changelog page can filter on it, and `npm run changelog:check` validates fragments, release headings and markers.
