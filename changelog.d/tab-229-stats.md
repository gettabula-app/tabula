section: Added

- `GET /api/internal/stats` for the control plane (TAB-229, `docs/cloud.md`): counts only, behind the same bearer token and 404 rules as `/api/internal/usage` and `/api/internal/version`. It reports boards, active and disabled members, guests, distinct people active in the last 7 and 30 days (a session or a recorded board change), AI runs in the last 30 days and chat messages. It never returns a name, address, id, board title or content; a test asserts that no personal string seeded into the directory appears in the answer.
