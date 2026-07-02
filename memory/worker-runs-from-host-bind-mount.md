---
name: worker-runs-from-host-bind-mount
description: The GPU worker container runs live host source via bind-mount; restart (not rebuild) applies code changes
metadata:
  type: project
---

The `splatapp-worker` Docker container on the 4090 box was started with `docker run` (NOT docker-compose) and **bind-mounts the host `worker/` dir into `/app/worker`**, shadowing the copy baked into the image. So it runs live host source.

**Why:** means edits to `worker/**` take effect on `docker restart splatapp-worker` — no image rebuild needed (rebuild only when `requirements.txt`/Dockerfile change). Conda env `splatapp` referenced in CLAUDE.md does NOT exist on the host; only CPU-only torch in `base`. All GPU work is in the container.

**Recreate command** (container gets removed often; image `splatapp-worker:latest` persists):
`docker run -d --name splatapp-worker --gpus all -p 8000:8000 -v "A:\Coding\Projects\SimpleGaussianSplatServer\worker:/app/worker" -v "A:\Coding\Projects\SimpleGaussianSplatServer\jobs:/app/jobs" -v splatapp-models:/app/.cache/huggingface -v splatapp-torch-ext:/app/.cache/torch_extensions -e SPLAT_QUEUE_URL=https://render-queue.hanksberger.workers.dev -e SPLAT_QUEUE_API_KEY=<key> -e SPLAT_GPU_DEVICE=cuda:0 -e SPLAT_JOBS_DIR=/app/jobs splatapp-worker:latest`

**How to apply:** edit host files → `docker restart splatapp-worker` (or recreate if gone) → verify with `docker exec splatapp-worker python -c "from worker.config import settings as s; print(...)"`. Container runs in **queue mode** (`SPLAT_QUEUE_URL=https://render-queue.hanksberger.workers.dev`); in this mode it polls the queue and does NOT accept direct benchmark uploads. As of 2026-06-23 that poll is failing with `SSL: SSLV3_ALERT_HANDSHAKE_FAILURE`, so no jobs flow — blocks testing. See [[splat-quality-root-cause]].
