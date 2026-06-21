#!/bin/bash
set -e

# Build the worker Docker image. The Dockerfile lives at the repo root and its
# build context must be the repo root (it COPYs worker/ and worker/requirements.txt),
# so resolve the root from this script's location regardless of where it's run.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

IMAGE_NAME="${IMAGE_NAME:-splatapp-worker}"
TAG="${TAG:-latest}"

echo "=== Building ${IMAGE_NAME}:${TAG} ==="
docker build -t "${IMAGE_NAME}:${TAG}" -f Dockerfile .
echo "=== Build complete: ${IMAGE_NAME}:${TAG} ==="
