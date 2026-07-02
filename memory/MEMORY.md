# Memory Index

- [Worker runs from host bind-mount](worker-runs-from-host-bind-mount.md) — restart the container (not rebuild) to apply `worker/` code changes; runs in queue mode
- [Splat quality root cause](splat-quality-root-cause.md) — bad output (floaters + ghosting) is speed-tuning, not PPISP; the real quality levers
- [COLMAP vs DUSt3R pose backend](colmap-vs-dust3r-pose-backend.md) — DUSt3R is the root cause of bad splats + OOM; COLMAP→LichtFeld proven better, migration deferred (now done in newworker/)
- [newworker COLMAP→LichtFeld MRNF](newworker-colmap-lichtfeld-mrnf.md) — v2 worker: COLMAP/DUSt3R poses → LichtFeld MRNF trainer, same HTTP+queue contract (validated on GPU via Docker)
- [newworker Docker GPU](newworker-docker-gpu.md) — v2 Dockerfile: MUST use Ubuntu 24.04 (GLIBC 2.38) + CUDA 12.8; lean (no torch); validated full pipeline → valid .splat on the 4090
