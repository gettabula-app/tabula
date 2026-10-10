# Nightly test suite

The nightly workflow runs at 03:17 UTC on `main`. It checks out `main`, then runs the full Vitest suite three times in sequence on Ubuntu, macOS and Windows using Node 24. Windows runs are unsharded for this repeated comparison. Each OS summary includes test classifications, skipped tests, its slowest tests and any tests above `test/timing-budget.json`; the JSON summaries are kept as workflow artifacts for 14 days.

## Reading the result

The summary labels a test `always-passed`, `always-failed`, `FLAKY` when it failed in some runs but not others, or `skipped`. Incomplete results and missing reports are called out as infrastructure errors. Timing-budget overruns are warnings in the report.

When a test fails or is flaky, the workflow creates or updates the single issue **Nightly: failing or flaky tests**, with the affected file, test, OS, failed runs out of three and a link to the workflow run. A later fully green night comments on and closes the open issue. Flaky results by themselves do not make the workflow fail; tests that fail in all three runs and infrastructure errors do. Skipped tests are shown separately.

## Run it by hand

In GitHub, open **Actions → Nightly test suite → Run workflow**. The workflow still checks out `main`, even if the manual dispatch was started from another branch. The run posts its per-OS and merged summaries, and applies the same issue behavior as a scheduled run.
