# SplatApp v2 worker — COLMAP / DUSt3R → LichtFeld MRNF

A rebuild of the GPU worker around a stronger pipeline. The v1 worker
(`../worker/`) estimated poses with DUSt3R and trained with a hand-rolled gsplat
loop; results weren't great. This version:

1. **COLMAP** geometric SfM for poses (primary) — sub-pixel accurate, undistorts
   phone-lens distortion to a clean PINHOLE dataset.
2. **DUSt3R** as an automatic fallback for captures COLMAP can't register
   (low texture, too few frames, fast motion).
3. **LichtFeld Studio** with the **MRNF** strategy for training — a fast native
   C++/CUDA 3DGS trainer (bundled in `bin/` + `lib/`).

It keeps the **exact same HTTP + queue contract** as v1, so it works unchanged
with the benchmark app (`../development/benchmark.html`) and the render-queue.

## How it works

Both pose backends emit one standard COLMAP/3DGS dataset, so the trainer has a
single input path:

```
<job_dir>/dataset/
    images/        undistorted (COLMAP) or copied (DUSt3R) training images
    sparse/0/      cameras.bin / images.bin / points3D.bin  (PINHOLE)
```

Pipeline stages (names match v1 — the benchmark/queue depend on them):

| Stage | What runs |
|-------|-----------|
| `frame_extraction` | ffmpeg uniform sampling + Laplacian blur report |
| `pose_estimation`  | COLMAP SfM → dataset; DUSt3R fallback writes the same layout |
| `training`         | `LichtFeld-Studio --headless --train --strategy mrnf` |
| `cleanup`          | prune low-opacity / oversized / floater Gaussians from the PLY |
| `conversion`       | PLY → `.splat` (or keep PLY) |

After cleanup a preview thumbnail is rendered from the final PLY (non-fatal).

## Layout

```
newworker/
  bin/  lib/  share/      # LichtFeld Studio native distribution (the trainer)
  splatworker/            # this worker (FastAPI service + pipeline)
    app.py                # HTTP API + orchestration (same contract as v1)
    config.py             # SPLAT_-prefixed settings
    queue_client.py       # render-queue polling
    pipeline/
      frames.py           # ffmpeg extraction + blur check
      poses.py            # backend dispatcher → dataset dir
      colmap_backend.py   # COLMAP SfM + undistort → dataset
      dust3r_backend.py   # DUSt3R → COLMAP dataset (fallback)
      colmap_io.py        # self-contained COLMAP .bin writer
      train.py            # drives LichtFeld headless (MRNF)
      cleanup.py          # PLY pruning
      convert.py          # PLY → .splat
      preview.py          # gsplat thumbnail render (optional)
```

## Run with Docker (recommended)

Validated on an RTX 4090. Needs Docker with the NVIDIA container runtime
(`--gpus` support) and an NVIDIA driver on the host. The image is self-contained
— it bundles the LichtFeld distribution, COLMAP (pycolmap), and ffmpeg.

```bash
cd newworker
./build.sh          # build the image (once, or after code changes)
./run.sh            # start the worker on :8000, logs in the foreground
```

`run.sh` env overrides:

```bash
PORT=8001 ./run.sh            # the v1 worker often holds :8000
DETACH=1 ./run.sh            # run in the background (prints container name)
JOBS_DIR=/abs/path ./run.sh  # host folder for job artifacts (default: ./jobs)
# IMAGE / TAG / NAME also override image + container naming.
```

A `.env` next to the scripts (queue config etc.) is passed through with
`--env-file`. Queue mode: set `SPLAT_QUEUE_URL` + `SPLAT_QUEUE_API_KEY`
(see `.env.example`). `run.sh` auto-builds the image if it's missing.

> **Base image note:** the Dockerfile uses **Ubuntu 24.04** + CUDA 12.8 on
> purpose — the bundled LichtFeld binary needs GLIBC 2.38 (22.04 is too old).

End-to-end validation against a sample video:

```bash
./validate.sh                                  # uses development/public/Splat_Sample.MOV
./validate.sh ../development/public/Couch.MOV   # or a video of your choice
```

> The Docker image is **lean by design**: no torch/gsplat/DUSt3R. The core
> COLMAP→LichtFeld path needs none of them. Consequences: the preview thumbnail
> is skipped and the DUSt3R fallback is unavailable (COLMAP handles normal phone
> orbits). To enable them, add `torch`/`gsplat` + clone DUSt3R in a later layer.

Health check / quick test (adjust the port to match `run.sh`):

```bash
curl http://localhost:8000/api/v1/health
curl -X POST http://localhost:8000/api/v1/jobs -F "video=@test.mp4"
curl http://localhost:8000/api/v1/jobs/<job_id>
```

## Run without Docker (local dev)

Runs on a Linux GPU host (the LichtFeld build is `x86_64-linux`) in a dedicated
conda/venv env, driving the unpacked `bin/` distribution directly.

```bash
cd newworker
conda create -n splatapp2 python=3.11 -y && conda activate splatapp2
pip install -r requirements.txt          # full deps incl. torch/gsplat (preview + DUSt3R)

# DUSt3R fallback (optional): clone to the repo root + install its deps.
git clone https://github.com/naver/dust3r ../dust3r
pip install -r ../dust3r/requirements.txt
# ffmpeg/ffprobe must be on PATH (apt install ffmpeg).

ENV=splatapp2 ./run-local.sh             # or: uvicorn splatworker.app:app --host 0.0.0.0 --port 8000
```

> **pycolmap** ships a self-contained manylinux wheel (bundles COLMAP + Ceres).
> If it won't install/import, the pose stage falls back to DUSt3R automatically.

## Configuration

All settings are `SPLAT_`-prefixed env vars (see `splatworker/config.py`). Key ones:

- `SPLAT_LICHTFELD_STRATEGY` — `mrnf` (default), `mcmc`, or `igs+`.
- `SPLAT_LICHTFELD_MAX_CAP` — Gaussian budget (`0` = strategy default).
- `SPLAT_LICHTFELD_EXTRA_ARGS` — extra raw CLI args (e.g. `--bilateral-grid --eval`).
- `SPLAT_DEFAULT_MAX_FRAMES` / `SPLAT_DEFAULT_RESOLUTION` / `SPLAT_DEFAULT_TRAINING_ITERATIONS`.
- `SPLAT_COLMAP_MATCHER` — `exhaustive` (robust) or `sequential` (faster).
- `SPLAT_DROP_BLURRY` — cull soft frames before SfM (default off: train on full set).
- `SPLAT_QUEUE_URL` / `SPLAT_QUEUE_API_KEY` — connect to the render queue.

## Debugging

Each job exports `colmap_dataset.zip` (`GET /api/v1/jobs/{id}/dataset`). Unzip and
open it directly in LichtFeld Studio (`bin/run_lichtfeld.sh -d <dir>`) to bisect
whether a bad result is the dataset (poses/undistortion) or the training run.

## Verification status

The **core path is validated end-to-end in Docker on an RTX 4090** (2026-06-28):
`Splat_Sample.MOV` → COLMAP 40/40 cameras → LichtFeld MRNF (2000 iters) → cleanup
→ a valid 30,172-Gaussian `.splat`. All `train.py::_build_command` flags match the
binary's `--help`, and training writes `splat_<iter>.ply` (found by
`_find_output_ply`). Reproduce with `./validate.sh`.

**Not yet exercised** (the Docker image is torch-free by design): the DUSt3R
fallback backend and the gsplat preview thumbnail. If you enable them (local dev,
or add the deps to the image), smoke-test those paths separately.
