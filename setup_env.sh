#!/bin/bash
set -e

ENV_NAME="${1:-splatapp}"

echo "=== SplatApp Environment Setup ==="
echo "Creating conda environment: $ENV_NAME"

# Create conda environment
conda create -n "$ENV_NAME" python=3.11 -y
eval "$(conda shell.bash hook)"
conda activate "$ENV_NAME"

# Install PyTorch with CUDA 12.1
echo "=== Installing PyTorch + CUDA 12.1 ==="
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121

# Install gsplat
echo "=== Installing gsplat ==="
pip install gsplat

# Clone and install DUSt3R
echo "=== Installing DUSt3R ==="
if [ ! -d "dust3r" ]; then
    git clone --recursive https://github.com/naver/dust3r.git
fi
cd dust3r
pip install -e .

# Build CroCo CUDA kernels (optional, improves speed)
echo "=== Building CroCo CUDA kernels ==="
cd croco/models/curope/
if python setup.py build_ext --inplace 2>/dev/null; then
    echo "CroCo CUDA kernels built successfully"
else
    echo "WARNING: CroCo CUDA kernels failed to build (non-fatal, will use PyTorch fallback)"
fi
cd ../../../..

# Install server dependencies
echo "=== Installing server dependencies ==="
pip install -r server/requirements.txt

# Verify ffmpeg
echo "=== Verifying FFmpeg ==="
if command -v ffmpeg &>/dev/null; then
    echo "ffmpeg found: $(ffmpeg -version | head -1)"
else
    echo "WARNING: ffmpeg not found. Install ffmpeg with NVDEC support for GPU-accelerated decoding."
    echo "  conda install -c conda-forge ffmpeg   (or download from https://ffmpeg.org)"
fi

# Verify CUDA
echo "=== Verifying CUDA ==="
python -c "import torch; print(f'PyTorch {torch.__version__}, CUDA available: {torch.cuda.is_available()}')"
python -c "import torch; print(f'GPU: {torch.cuda.get_device_name(0)}')" 2>/dev/null || echo "No GPU detected"

# Verify DUSt3R
echo "=== Verifying DUSt3R ==="
python -c "from dust3r.model import AsymmetricCroCo3DStereo; print('DUSt3R import OK')"

# Verify gsplat
echo "=== Verifying gsplat ==="
python -c "from gsplat import rasterization; print('gsplat import OK')"

echo ""
echo "=== Setup Complete ==="
echo "To start the server:"
echo "  conda activate $ENV_NAME"
echo "  uvicorn server.app:app --host 0.0.0.0 --port 8000"
