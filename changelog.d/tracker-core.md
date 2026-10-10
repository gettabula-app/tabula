section: Added
audience: user

- Workspace ticket tracking now supports ticket records, workflow states, activity history, filters, search, and a session REST API for signed-in workspace members. `TABULA_TRACKER` keeps tracker routes and tools off by default; MCP still requires a token with tracker read or write access. The `due:today` filter uses UTC until workspace time zones are supported.
- Tracker tickets now support projects, milestones and bidirectional relations, with saved views and MCP tools to manage them. Relation changes are recorded on both tickets; shared views run with the caller's access.
