#!/bin/bash
set -euo pipefail

umask 077

if [[ "$#" -ne 1 || ! "$1" =~ ^[0-9a-f]{32}$ ]]; then
  exit 64
fi

job_id="$1"

exec -c /usr/bin/env -i \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  TMPDIR=/scratch \
  TMP=/scratch \
  TEMP=/scratch \
  PYTHONNOUSERSITE=1 \
  PYTHONDONTWRITEBYTECODE=1 \
  /usr/bin/node \
  /opt/turingmarket-parser/app/services/upload_sandbox_service.js \
  worker \
  --job-id "$job_id" \
  --request /runtime/request.json \
  --input /input/input.bin \
  --output-root /output
