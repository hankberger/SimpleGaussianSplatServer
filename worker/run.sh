#!/bin/bash
set -e

# Run the worker Docker image with GPU access. Mirrors docker-compose.yml:
# same port, named volumes (shared with compose), and env defaults.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

IMAGE_NAME="${IMAGE_NAME:-splatapp-worker}"
TAG="${TAG:-latest}"
CONTAINER_NAME="${CONTAINER_NAME:-splatapp-worker}"

# Forward queue-worker mode settings if they're set in the environment.
EXTRA_ENV=()
[ -n "$SPLAT_QUEUE_URL" ]     && EXTRA_ENV+=(-e "SPLAT_QUEUE_URL=$SPLAT_QUEUE_URL")
[ -n "$SPLAT_QUEUE_API_KEY" ] && EXTRA_ENV+=(-e "SPLAT_QUEUE_API_KEY=$SPLAT_QUEUE_API_KEY")

echo "=== Running ${IMAGE_NAME}:${TAG} (container: ${CONTAINER_NAME}) ==="
docker run --rm -it \
    --gpus all \
    --name "$CONTAINER_NAME" \
    -p 8000:8000 \
    -v splatapp-jobs:/app/jobs \
    -v splatapp-models:/app/.cache/huggingface \
    -e SPLAT_GPU_DEVICE=cuda:0 \
    -e SPLAT_JOBS_DIR=/app/jobs \
    "${EXTRA_ENV[@]}" \
    "${IMAGE_NAME}:${TAG}"
