section: Fixed
audience: dev

- The nightly report expected macOS and Windows results that the Linux-only nightly no longer produces, so it failed every night, and its two Linux legs (Node 22 and 24) uploaded under the same artifact name. Each leg is now reported as `ubuntu-latest-node22` and `ubuntu-latest-node24`.
