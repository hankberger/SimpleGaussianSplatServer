#!/bin/bash
set -e

# Run the worker Docker image with GPU access.
#
# Job artifacts are bind-mounted to a host folder so you can inspect outputs
# (default: <repo>/jobs, override with JOBS_DIR=/abs/path). The IN-CONTAINER
# path is always /app/jobs — never pass a host/Windows path as SPLAT_JOBS_DIR,
# or ffmpeg reads the leading drive letter as a URL protocol ("Protocol not
# found") and paths resolve to the container's throwaway layer.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

IMAGE_NAME="${IMAGE_NAME:-splatapp-worker}"
TAG="${TAG:-latest}"
CONTAINER_NAME="${CONTAINER_NAME:-splatapp-worker}"

# Host directory for job artifacts (created if missing).
# On Git Bash/MSYS, convert host paths to the Windows form Docker Desktop wants.
# (Container-side paths are protected from MSYS mangling via MSYS_NO_PATHCONV below.)
to_host_path() {
    if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

HOST_JOBS_DIR="${JOBS_DIR:-$REPO_ROOT/jobs}"
mkdir -p "$HOST_JOBS_DIR"
HOST_JOBS_MOUNT="$(to_host_path "$HOST_JOBS_DIR")"

# Load .env (queue config etc.) if present.
ENV_FILE_ARG=()
if [ -f "$REPO_ROOT/.env" ]; then
    ENV_FILE_ARG=(--env-file "$(to_host_path "$REPO_ROOT/.env")")
fi

# DEV=1 live-mounts the worker source over the image's copy so code changes take
# effect on container restart with no rebuild. Leave unset for normal runs.
DEV_MOUNT=()
if [ "${DEV:-0}" = "1" ]; then
    DEV_MOUNT=(-v "$(to_host_path "$REPO_ROOT/worker"):/app/worker")
    echo "    DEV: live-mounting worker/ source (no rebuild needed)"
fi

echo "=== Running ${IMAGE_NAME}:${TAG} (container: ${CONTAINER_NAME}) ==="
echo "    jobs: ${HOST_JOBS_MOUNT} -> /app/jobs"
# MSYS_NO_PATHCONV stops Git Bash from mangling the container-side /app/jobs path.
MSYS_NO_PATHCONV=1 docker run --rm -it \
    --gpus all \
    --name "$CONTAINER_NAME" \
    -p 8000:8000 \
    -v "${HOST_JOBS_MOUNT}:/app/jobs" \
    -v splatapp-models:/app/.cache/huggingface \
    -v splatapp-torch-ext:/app/.cache/torch_extensions \
    "${DEV_MOUNT[@]}" \
    "${ENV_FILE_ARG[@]}" \
    -e SPLAT_GPU_DEVICE=cuda:0 \
    -e SPLAT_JOBS_DIR=/app/jobs \
    "${IMAGE_NAME}:${TAG}"
