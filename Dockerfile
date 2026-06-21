# ==============================================================================
# Stage 1: Builder — install dependencies and compile CUDA extensions
# ==============================================================================
FROM nvidia/cuda:12.1.1-devel-ubuntu22.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive

# Install Python 3.11 via deadsnakes PPA
RUN apt-get update && apt-get install -y --no-install-recommends \
        software-properties-common \
        git \
        curl \
    && add-apt-repository ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y --no-install-recommends \
        python3.11 \
        python3.11-venv \
        python3.11-dev \
    && rm -rf /var/lib/apt/lists/*

# Create virtualenv
RUN python3.11 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install PyTorch with CUDA 12.1
RUN pip install --no-cache-dir \
    torch torchvision --index-url https://download.pytorch.org/whl/cu121

# Clone and install DUSt3R
WORKDIR /app
RUN git clone --recursive https://github.com/naver/dust3r.git
RUN pip install --no-cache-dir -r dust3r/requirements.txt

# Build CroCo CUDA kernels (non-fatal — falls back to PyTorch if this fails)
RUN cd dust3r/croco/models/curope/ \
    && python setup.py build_ext --inplace 2>/dev/null \
    && echo "CroCo CUDA kernels built successfully" \
    || echo "CroCo CUDA kernels failed (non-fatal, will use PyTorch fallback)"

# Install worker dependencies (separate COPY for layer caching)
COPY worker/requirements.txt /app/worker/requirements.txt

# PPISP compiles a CUDA extension at install time. Its setup.py detects the GPU
# arch from the live device, but no GPU is visible during `docker build`, so it
# falls back to a hardcoded arch list that includes sm_120 (Blackwell) — which
# CUDA 12.1's nvcc cannot compile ("Unsupported gpu architecture 'compute_120'").
# Pre-install a copy with that arch dropped; the remaining 7.5/8.0/8.9 cover the
# 4090 (sm_89). It ignores TORCH_CUDA_ARCH_LIST, hence the source patch.
RUN git clone --depth 1 --branch v1.0.0 https://github.com/nv-tlabs/ppisp.git /tmp/ppisp \
    && sed -i '/compute_120/d' /tmp/ppisp/setup.py \
    && pip install --no-cache-dir --no-build-isolation /tmp/ppisp \
    && rm -rf /tmp/ppisp

# Install the remaining worker deps (ppisp filtered out — already built above).
# --no-build-isolation lets CUDA extensions find the installed torch + toolkit.
RUN grep -v '^ppisp' worker/requirements.txt > /tmp/requirements.txt \
    && pip install --no-cache-dir --no-build-isolation -r /tmp/requirements.txt

# ==============================================================================
# Stage 2: Runtime — lean(ish) image with everything needed to run
# ==============================================================================
FROM nvidia/cuda:12.1.1-devel-ubuntu22.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive

# Install Python 3.11, FFmpeg, and runtime libs
RUN apt-get update && apt-get install -y --no-install-recommends \
        software-properties-common \
        curl \
    && add-apt-repository ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y --no-install-recommends \
        python3.11 \
        python3.11-venv \
        python3.11-dev \
        ffmpeg \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy virtualenv and DUSt3R from builder
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /app/dust3r /app/dust3r

ENV PATH="/opt/venv/bin:$PATH"

# Copy worker source
COPY worker/ /app/worker/

# Environment defaults
ENV SPLAT_JOBS_DIR=/app/jobs \
    SPLAT_GPU_DEVICE=cuda:0 \
    HF_HOME=/app/.cache/huggingface \
    TORCH_EXTENSIONS_DIR=/app/.cache/torch_extensions \
    PYTHONUNBUFFERED=1

# Health check — long start-period to allow first-run model download (~3.5GB)
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:8000/api/v1/health || exit 1

EXPOSE 8000

CMD ["uvicorn", "worker.app:app", "--host", "0.0.0.0", "--port", "8000"]
