section: Added
audience: dev

- A hosted instance keeps the report of the last finished hour (the same scrubbed report the Privacy tab previews, built once in the last seconds of each hour) and hands it to the control plane at `GET /api/internal/telemetry`, with the control token only. It answers 204 when `TABULA_TELEMETRY=off`, 503 until an hour has finished or while a restore runs, and drops the hour on an owner opt-out of product analytics. The instance itself still sends nothing.
