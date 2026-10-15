section: Added
audience: dev

- The control plane can send a restart notice (`PUT /api/internal/restart-notice`): it is kept in memory, shown as a countdown in `/api/me` and announced to open sockets, and every signal is audited.
