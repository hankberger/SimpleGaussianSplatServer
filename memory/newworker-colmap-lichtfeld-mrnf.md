---
name: newworker-colmap-lichtfeld-mrnf
description: newworker/ is the v2 GPU worker — COLMAP/DUSt3R poses → LichtFeld Studio MRNF training, same HTTP+queue contract as v1
metadata:
  type: project
---

`newworker/` is the rebuilt GPU worker (started 2026-06-28), executing the COLMAP→LichtFeld migration that [[colmap-vs-dust3r-pose-backend]] said was proven-better-but-deferred. v1 (`worker/`) used DUSt3R poses + a hand-rolled gsplat trainer; v2 uses geometric COLMAP poses + LichtFeld Studio's native MRNF trainer.

**Layout:** `newworker/{bin,lib,share}/` is the unpacked **LichtFeld Studio** native distribution (x86_64-linux; the trainer binary + bundled libs — NOT a pip package). The worker service is `newworker/splatworker/` (a Python package; run `uvicorn splatworker.app:app` from inside `newworker/`).

**Design — both pose backends emit ONE COLMAP/3DGS dataset** (`<job>/dataset/images/` + `sparse/0/{cameras,images,points3D}.bin`, PINHOLE) so the trainer has a single input path:
- COLMAP (primary, `colmap_backend.py`): pycolmap SfM + `undistort_images` → moved into `dataset/images` + `dataset/sparse/0`. Same OPENCV-model/exhaustive-matcher recipe as v1.
- DUSt3R (fallback, `dust3r_backend.py`): runs DUSt3R then writes the SAME layout via `colmap_io.py` — a self-contained COLMAP **binary** writer (avoids pycolmap-version Reconstruction-construction pitfalls). NO scene normalization in v2 (LichtFeld normalizes at load).
- `poses.py` dispatches COLMAP→DUSt3R on failure / registered < `colmap_min_registered_frac`.

**Training (`train.py`):** subprocess `bin/run_lichtfeld.sh --headless --train -d <dataset> -o <out> --strategy mrnf -i <iter> --images images -r 1 --sh-degree 3 [--max-cap N]`. Streams stdout, regex-parses `step/total`+`loss` for progress, then globs `<out>/**/*.ply` (highest trailing int). **MRNF** = LichtFeld's strategy, selected via `--strategy mrnf` (valid: mcmc, mrnf, igs+; legacy aliases mnrf, lfs). CLI flags confirmed from the LichtFeld wiki Command-Line-Options page, NOT verified against the bundled binary.

**Contract preserved:** identical stage names (`frame_extraction, pose_estimation, training, cleanup, conversion`) + endpoints (`/api/v1/jobs`, `/result`, `/preview`, `/dataset`, `/health`) + `queue_client.py` protocol, so the benchmark app and render-queue work unchanged. `cleanup.py`/`convert.py` reused from v1; `preview.py` renders a thumbnail from the final PLY via gsplat+pycolmap (optional/non-fatal).

**VALIDATED ON GPU (2026-06-28) via Docker** — see [[newworker-docker-gpu]]. The COLMAP→LichtFeld(MRNF)→cleanup→convert core path ran end-to-end on the 4090 and produced a valid `.splat`; all `train.py::_build_command` flag spellings matched the binary's `--help`, and training writes `splat_<iter>.ply` (found by `_find_output_ply`). The DUSt3R fallback + gsplat preview were NOT exercised (the Docker image is torch-free by design) — if you enable them, smoke-test separately. Needs its own env (`requirements.txt`) + DUSt3R cloned to repo-root `dust3r/` for the fallback.
