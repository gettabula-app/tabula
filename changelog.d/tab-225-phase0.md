section: Added

- Added schema compatibility metadata so expand-only migrations can be rolled back one generation by default.
- Added `GET /api/internal/version` for the control plane to inspect the build and database schema generations.
- Added `npm run release-info` and the `TABULA_VERSION` Docker build argument for release reporting.
- Added migration lint checks for SQL patterns that need an explicit reader declaration.
