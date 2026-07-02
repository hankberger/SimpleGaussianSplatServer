#!/bin/bash
# End-to-end validation: start the v2 worker container on GPU, push a sample
# video through the full pipeline, and confirm a .splat result is produced.
#
# Usage: ./validate.sh [path-to-video]
#   IMAGE=splatapp-worker2:latest  ITERS=2000  FRAMES=40  RES=768  ./validate.sh
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

IMAGE="${IMAGE:-splatapp-worker2:latest}"
NAME="${NAME:-splat2-validate}"
PORT="${PORT:-8000}"
VIDEO="${1:-$REPO_ROOT/development/public/Splat_Sample.MOV}"
ITERS="${ITERS:-2000}"
FRAMES="${FRAMES:-40}"
RES="${RES:-768}"

HOST_JOBS="$SCRIPT_DIR/jobs"
mkdir -p "$HOST_JOBS"
to_host() { command -v cygpath >/dev/null 2>&1 && cygpath -w "$1" || printf '%s' "$1"; }

echo "=== Starting $IMAGE as $NAME ==="
docker rm -f "$NAME" >/dev/null 2>&1 || true
MSYS_NO_PATHCONV=1 docker run -d --rm --gpus all \
    --name "$NAME" -p "${PORT}:8000" \
    -v "$(to_host "$HOST_JOBS"):/app/jobs" \
    "$IMAGE" >/dev/null

echo "=== Waiting for health ==="
for _ in $(seq 1 60); do
    if curl -sf "http://localhost:${PORT}/api/v1/health" >/dev/null 2>&1; then break; fi
    sleep 1
done
curl -s "http://localhost:${PORT}/api/v1/health"; echo

echo "=== Submitting $VIDEO (iters=$ITERS frames=$FRAMES res=$RES) ==="
JOB=$(curl -s -X POST "http://localhost:${PORT}/api/v1/jobs" \
    -F "video=@${VIDEO}" -F "training_iterations=${ITERS}" \
    -F "max_frames=${FRAMES}" -F "resolution=${RES}" -F "output_format=splat")
echo "$JOB"
JOB_ID=$(echo "$JOB" | sed -n 's/.*"job_id":"\([^"]*\)".*/\1/p')
[ -z "$JOB_ID" ] && { echo "No job_id"; docker logs "$NAME" | tail -40; exit 1; }

echo "=== Polling job $JOB_ID ==="
while true; do
    S=$(curl -s "http://localhost:${PORT}/api/v1/jobs/${JOB_ID}")
    ST=$(echo "$S" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
    echo "[$(date +%H:%M:%S)] $ST :: $S"
    case "$ST" in
        completed) break ;;
        failed) echo "JOB FAILED"; docker logs "$NAME" | tail -60; exit 1 ;;
    esac
    sleep 5
done

echo "=== Downloading result ==="
curl -s "http://localhost:${PORT}/api/v1/jobs/${JOB_ID}/result" -o "$HOST_JOBS/${JOB_ID}.splat"
ls -la "$HOST_JOBS/${JOB_ID}.splat"
echo "=== SUCCESS ==="
