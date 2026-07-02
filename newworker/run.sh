#!/bin/bash
# Run the SplatApp v2 worker CONTAINER on the GPU.
#
#   ./build.sh        # build the image first (once, or after code changes)
#   ./run.sh          # start the worker on :8000, logs in the foreground
#
# Env overrides:
#   PORT=8001 ./run.sh          # the v1 worker often holds :8000
#   DETACH=1 ./run.sh           # run in the background, print the container name
#   JOBS_DIR=/abs/path ./run.sh # host folder for job artifacts (default: ./jobs)
#   IMAGE=… TAG=… NAME=…        # image/container naming
#
# A .env file next to this script (queue config etc.) is passed through with
# --env-file. Stop a foreground run with Ctrl+C; a detached run with
# `docker rm -f <NAME>`.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="${IMAGE:-${IMAGE_NAME:-splatapp-worker2}}"
TAG="${TAG:-latest}"
IMAGE_REF="${IMAGE_NAME}:${TAG}"
NAME="${NAME:-splatapp-worker2}"
PORT="${PORT:-8000}"

# Host directory for job artifacts (created if missing). On Git Bash/MSYS convert
# host paths to the Windows form Docker Desktop wants; container paths are guarded
# from MSYS mangling via MSYS_NO_PATHCONV below.
to_host() { command -v cygpath >/dev/null 2>&1 && cygpath -w "$1" || printf '%s' "$1"; }
HOST_JOBS="${JOBS_DIR:-$SCRIPT_DIR/jobs}"
mkdir -p "$HOST_JOBS"

# Build on demand if the image is missing.
if [ -z "$(docker images -q "$IMAGE_REF" 2>/dev/null)" ]; then
    echo "=== Image $IMAGE_REF not found — building ==="
    IMAGE_NAME="$IMAGE_NAME" TAG="$TAG" ./build.sh
fi

# Pass through a .env file if present.
ENV_FILE_ARG=()
[ -f "$SCRIPT_DIR/.env" ] && ENV_FILE_ARG=(--env-file "$(to_host "$SCRIPT_DIR/.env")")

# Foreground (--rm, streams logs) unless DETACH=1.
RUN_MODE=(--rm -it)
[ "${DETACH:-0}" = "1" ] && RUN_MODE=(-d)

# Replace any existing container with the same name.
docker rm -f "$NAME" >/dev/null 2>&1 || true

echo "=== Running $IMAGE_REF as '$NAME' on :$PORT (jobs: $HOST_JOBS) ==="
MSYS_NO_PATHCONV=1 docker run "${RUN_MODE[@]}" \
    --gpus all \
    --name "$NAME" \
    -p "${PORT}:8000" \
    -v "$(to_host "$HOST_JOBS"):/app/jobs" \
    "${ENV_FILE_ARG[@]}" \
    "$IMAGE_REF"

if [ "${DETACH:-0}" = "1" ]; then
    echo "Started detached. Logs: docker logs -f $NAME | Stop: docker rm -f $NAME"
    echo "Health: curl http://localhost:${PORT}/api/v1/health"
fi
