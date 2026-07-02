#!/bin/bash
# Build the v2 worker image. Build context is THIS directory (newworker/), so the
# bundled LichtFeld distribution (bin/, lib/, share/) and splatworker/ are copied
# in; the heavy sibling dirs (mobile/, render-queue/node_modules) are excluded.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="${IMAGE_NAME:-splatapp-worker2}"
TAG="${TAG:-latest}"

echo "=== Building ${IMAGE_NAME}:${TAG} (context: $SCRIPT_DIR) ==="
docker build -t "${IMAGE_NAME}:${TAG}" -f Dockerfile .
echo "=== Build complete: ${IMAGE_NAME}:${TAG} ==="
