#!/usr/bin/env bash
# Prints the digest of every image tag in compose.yaml so they can be pinned as image: name:tag@sha256:... .
# Needs network and a running Docker (buildx). It does not edit anything: review the output, then edit compose.yaml.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
grep -E '^\s+image: [^@]+$' "$here/compose.yaml" | awk '{print $2}' | grep -v '^tabula-telemetry-collector' | while read -r image; do
  digest="$(docker buildx imagetools inspect "$image" --format '{{json .Manifest.Digest}}' | tr -d '"')"
  echo "image: ${image}@${digest}"
done
