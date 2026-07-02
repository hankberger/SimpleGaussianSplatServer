# ==============================================================================
# SplatApp v2 worker — COLMAP/DUSt3R → LichtFeld MRNF, in a GPU container.
#
# Base: Ubuntu 24.04 is REQUIRED — the bundled LichtFeld Studio binary needs
# GLIBC_2.38 (Ubuntu 22.04 ships 2.35). CUDA 12.8 runtime matches LichtFeld's
# bundled libcudart 12.8; libcuda.so.1 (the driver) is injected at run time by
# the NVIDIA container runtime (`--gpus all`).
# ==============================================================================
FROM nvidia/cuda:12.8.1-runtime-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive

# System libs:
#  - ffmpeg                : frame extraction
#  - libgtk-3 / glib / X11 : LichtFeld links these even in --headless (NEEDED
#                            entries in the ELF), so they must be loadable.
#  - libgomp1, libvulkan1  : LichtFeld runtime deps (Vulkan ICD comes from the
#                            driver via NVIDIA_DRIVER_CAPABILITIES=graphics).
#  - xvfb                  : virtual X display, used only if a headless run still
#                            insists on a display (entrypoint falls back to it).
#  - python3 venv/pip      : the worker service itself.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-venv python3-pip \
        ffmpeg \
        libglib2.0-0t64 libgl1 libgomp1 libvulkan1 \
        libx11-6 libxext6 libxrender1 libegl1 \
        xvfb curl ca-certificates \
    && (apt-get install -y --no-install-recommends libgtk-3-0t64 \
        || apt-get install -y --no-install-recommends libgtk-3-0) \
    && rm -rf /var/lib/apt/lists/*

# Isolated venv (24.04's system python is externally-managed).
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir --upgrade pip

WORKDIR /app/newworker

# Install core Python deps first for layer caching (changes rarely).
COPY requirements-docker.txt ./requirements-docker.txt
RUN pip install --no-cache-dir -r requirements-docker.txt

# Copy the worker + the LichtFeld distribution (bin/, lib/, share/, splatworker/).
COPY . /app/newworker
RUN chmod +x bin/run_lichtfeld.sh bin/LichtFeld-Studio docker-entrypoint.sh 2>/dev/null || true

ENV SPLAT_JOBS_DIR=/app/jobs \
    SPLAT_GPU_DEVICE=cuda:0 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/newworker \
    HF_HOME=/app/.cache/huggingface \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=all

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8000/api/v1/health || exit 1

EXPOSE 8000

ENTRYPOINT ["/app/newworker/docker-entrypoint.sh"]
CMD ["uvicorn", "splatworker.app:app", "--host", "0.0.0.0", "--port", "8000"]
