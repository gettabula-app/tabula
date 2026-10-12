# Build context: the repository root (the collector shares server/telemetry/{schema.json,schema.mjs,scrub.mjs} with the app,
# so the validation rules are the same files). Used for the collector and the lake job.
FROM node:22-bookworm-slim

ARG DUCKDB_VERSION=1.4.3
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && arch="$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo amd64)" \
  && curl -fsSL "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/duckdb_cli-linux-${arch}.zip" -o /tmp/duckdb.zip \
  && unzip -q /tmp/duckdb.zip -d /usr/local/bin duckdb \
  && chmod 0755 /usr/local/bin/duckdb \
  && rm -rf /tmp/duckdb.zip /var/lib/apt/lists/* \
  && apt-get purge -y --auto-remove curl unzip

WORKDIR /app
COPY server/telemetry/schema.json server/telemetry/schema.mjs server/telemetry/scrub.mjs ./server/telemetry/
COPY telemetry-collector/src ./telemetry-collector/src

ENV NODE_ENV=production TELEMETRY_DATA_DIR=/data
USER node
ENTRYPOINT ["node", "telemetry-collector/src/cli.mjs"]
CMD ["serve"]
