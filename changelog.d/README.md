# Changelog fragments

Add one fragment for each change in `changelog.d/`. Fragments collect release notes without making concurrent changes edit `CHANGELOG.md` at the same time. The folder's `README.md` is documentation, never a fragment.

## Format

Name each file with lowercase letters, digits, dots, dashes or underscores, ending in `.md`, for example `tab-123.md` or `fix-board-export.md`. Use one fragment per change, not one per commit.

The first line is `section: <Name>`, where `<Name>` is `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` or `Security`. An optional second line `audience: user` or `audience: dev` says who the entry is for (default `user`: it shows on the product's changelog page; `dev` is for people working on Tabula, such as tooling, tests and internal docs). Fold keeps the audience by ending each `dev` bullet with `<!-- audience: dev -->`; `user` bullets carry no marker, and a fragment's own bullets may not contain `<!--`. Follow the header line(s) with one blank line, then one or more bullets beginning `- ` at column 0. A continuation line must start with exactly two spaces; folding joins it to the bullet with one space and trims it. No other content is allowed. Use LF line endings, no tabs, and end the file with a newline. Trailing spaces are trimmed when folded. Keep each fragment at or below 8 KB and at or below 20 bullets. Do not include keys or secrets.

Good example (`tab-123.md`):

```markdown
section: Added

- Export a board as Markdown from the board menu.
  The export includes visible comments and keeps text literal.
```

Bad example:

```markdown
section: Added
- New export option.
This continuation is not indented.
```

The bad example has no blank line after the section and its continuation does not start with two spaces.

Do not edit `CHANGELOG.md` for each change. The person who merges to `main` runs `npm run changelog:fold`, then commits the updated `CHANGELOG.md`. Run `npm run changelog:check` to check fragment format and the Unreleased heading before merging.

## Cutting a release

To record a release, run `npm run changelog:fold -- --release <version>` (add `--date <YYYY-MM-DD>` to set the date; it defaults to today, UTC), and commit `CHANGELOG.md`. The fragments are folded as usual, then the Unreleased section is cut: an empty `## [Unreleased]` stays at the top and everything that was in it sits under `## [<version>] - <YYYY-MM-DD>`. Add `--dry-run` to see the summary only. A version that already has a heading is refused. `npm run changelog:check` validates the fragments (section and audience), that every other `## ` heading in `CHANGELOG.md` is `## [<version>] - <YYYY-MM-DD>` with each version once, and that every `<!--` is an audience marker at the end of a bullet.
