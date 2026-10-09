section: Added

- A release workflow: a `v*` tag (or a manual run) runs the full CI gates, builds the Docker image with `TABULA_VERSION`
  set to the tag, pushes it to the Fly registry and can register it with the control plane. Without its secrets it
  skips the push and register steps with a notice instead of failing. See `docs/releasing.md`.
