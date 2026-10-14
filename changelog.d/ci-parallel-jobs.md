section: Changed
audience: dev

- CI runs the browser tests in their own job beside the unit tests and the Docker build instead of one after the other (the slowest job was unit plus browser tests in a row), builds the Docker image in parallel and pushes it only after the tests pass (main and release tags only), and no longer cancels runs on main: only a newer push to the same pull request cancels an older run. The unused `dist` artifact is gone. `TABULA_TEST_SET=unit` or `browser` runs one half of the suite locally.
