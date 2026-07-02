---
name: newworker-docker-gpu
description: newworker/ Dockerfile — Ubuntu 24.04 + CUDA 12.8 base (GLIBC 2.38 needed), validated running the full pipeline on the 4090
metadata:
  type: project
---

`newworker/Dockerfile` containerizes the v2 worker ([[newworker-colmap-lichtfeld-mrnf]]) and was validated end-to-end on the RTX 4090 (2026-06-28): Splat_Sample.MOV → COLMAP 40/40 cams, 18188 pts → LichtFeld **MRNF** headless 2000 iters (loss 0.043, ~84 iter/s) → cleanup → a valid 30172-Gaussian `.splat` (965504 B = 30172×32 exactly). Image `splatapp-worker2:latest`, ~5.5 GB.

**Hard requirements discovered (don't regress these):**
- **Base MUST be Ubuntu 24.04** — the bundled LichtFeld binary needs `GLIBC_2.38`; 22.04 (the v1 base, glibc 2.35) is too old and won't load it. Use `nvidia/cuda:12.8.1-runtime-ubuntu24.04` (matches LichtFeld's bundled libcudart 12.8; `runtime` is enough — no nvcc needed for the core path since pycolmap ships a self-contained wheel).
- LichtFeld's ELF has NEEDED entries for **GTK3 + GLib + X11 + libgomp + libvulkan** even in `--headless`, so apt-install `libgtk-3-0t64 libglib2.0-0t64 libgl1 libgomp1 libvulkan1 libx11-6 libxext6 libxrender1 libegl1`. (24.04 uses the `t64` package names; `libgtk-3-0` has a fallback in the Dockerfile.)
- `docker-entrypoint.sh` starts **Xvfb on :99** and exports DISPLAY before exec — belt-and-suspenders against any GTK/X init in headless mode. Worked; unclear if strictly required, keep it.
- Run with `--gpus all`; ENV `NVIDIA_DRIVER_CAPABILITIES=all` (Vulkan ICD + libcuda.so.1 are injected by the NVIDIA container runtime, NOT in the image — absent during `docker build`, present at run).

**Lean by design:** the image installs only `requirements-docker.txt` (fastapi/uvicorn/pydantic/httpx/numpy/scipy/opencv-headless/plyfile/**pycolmap**) — NO torch/gsplat/dust3r. The core COLMAP→LichtFeld→cleanup→convert path needs none of them. Consequences: the **preview** thumbnail is skipped (logs one non-fatal `ModuleNotFoundError: torch` traceback — harmless, job still completes) and the **DUSt3R fallback** is unavailable (COLMAP handles normal phone orbits). `utils/gpu.py` was given an `nvidia-smi` fallback so `/health` reports the GPU without torch. Add torch (cu124) + gsplat + clone dust3r to `/app/dust3r` in a later layer if you want previews/fallback.

**Build/run:** context = `newworker/` (its `.dockerignore` excludes `jobs/`). `newworker/build.sh` builds; `newworker/validate.sh [video]` runs the container (`-p 8001:8000` to avoid the v1 worker on 8000) and pushes a sample through. Build context is ~800 MB (the bundled bin/lib/share). pycolmap resolved to **4.1.0** (cp312 wheel) on py3.12.
