#!/bin/bash
# Run the SplatApp v2 worker DIRECTLY (no Docker), driving the unpacked LichtFeld
# Studio distribution in bin/ + lib/ from a conda/venv env on the Linux GPU host.
# For the containerized path (recommended) use ./build.sh + ./run.sh instead.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Activate the env if a name is given (e.g. ENV=splatapp2 ./run-local.sh).
if [ -n "${ENV:-}" ]; then
    # shellcheck disable=SC1091
    source "$(conda info --base)/etc/profile.d/conda.sh"
    conda activate "$ENV"
fi

export SPLAT_JOBS_DIR="${SPLAT_JOBS_DIR:-$SCRIPT_DIR/jobs}"
export SPLAT_GPU_DEVICE="${SPLAT_GPU_DEVICE:-cuda:0}"

# Make the bundled trainer executable (first run after unpack/clone).
chmod +x bin/run_lichtfeld.sh bin/LichtFeld-Studio 2>/dev/null || true

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
echo "=== SplatApp v2 worker (local) on ${HOST}:${PORT} (jobs: ${SPLAT_JOBS_DIR}) ==="
exec uvicorn splatworker.app:app --host "$HOST" --port "$PORT"
