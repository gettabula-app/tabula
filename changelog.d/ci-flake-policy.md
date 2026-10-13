section: Changed
audience: dev

- CI retries a failing browser test once (browser files only; never on a release run) and lists every test that passed on its retry in the job summary and as a warning, so a known timing flake no longer turns main red but stays visible. `workflow_dispatch` takes a `max-workers` input to try another number of parallel test files.
