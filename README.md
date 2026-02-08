# SplatApp

Video-to-Gaussian-Splat pipeline with a WebGL viewer. Upload a video, get back a navigable 3D scene.

## Prerequisites

- NVIDIA GPU with CUDA support (tested on RTX 4090)
- CUDA Toolkit 12.1+
- Conda (Miniconda or Anaconda)
- Node.js 18+
- FFmpeg (with NVDEC for GPU-accelerated decoding, optional but recommended)
- Git

## Setup

### Option A: Automated setup (Linux)

```bash
git clone https://github.com/hankberger/SimpleGaussianSplatServer.git
cd SimpleGaussianSplatServer
bash setup_env.sh
conda activate splatapp
uvicorn server.app:app --host 0.0.0.0 --port 8000
```

### Option B: Manual setup

#### 1. Clone the repo

```bash
git clone https://github.com/hankberger/SimpleGaussianSplatServer.git
cd SimpleGaussianSplatServer
```

#### 2. Create conda environment

```bash
conda create -n splatapp python=3.11 -y
conda activate splatapp
```

#### 3. Install PyTorch with CUDA

```bash
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
```

#### 4. Install DUSt3R

DUSt3R must be cloned into the repo root (the server expects it at `./dust3r/`):

```bash
git clone --recursive https://github.com/naver/dust3r.git
cd dust3r
pip install -e .
```

Optionally build CroCo CUDA kernels for faster inference:

```bash
cd croco/models/curope/
python setup.py build_ext --inplace
cd ../../../..
```

#### 5. Install gsplat and server dependencies

```bash
pip install gsplat
pip install -r server/requirements.txt
```

#### 6. Install FFmpeg

```bash
# Option 1: via conda
conda install -c conda-forge ffmpeg

# Option 2: system package manager (Ubuntu/Debian)
sudo apt install ffmpeg
```

#### 7. Install renderer dependencies

```bash
cd renderer
npm install
cd ..
```

#### 8. Verify installation

```bash
python -c "import torch; print(f'PyTorch {torch.__version__}, CUDA: {torch.cuda.is_available()}, GPU: {torch.cuda.get_device_name(0)}')"
python -c "from dust3r.model import AsymmetricCroCo3DStereo; print('DUSt3R OK')"
python -c "from gsplat import rasterization; print('gsplat OK')"
ffmpeg -version | head -1
```

## Running

### 1. Start the processing server

```bash
conda activate splatapp
uvicorn server.app:app --host 0.0.0.0 --port 8000
```

The first job will be slow as DUSt3R downloads and caches its model weights (~3.5 GB).

### 2. Start the renderer

In a separate terminal:

```bash
cd renderer
npm start
```

The renderer runs at **http://localhost:9000**.

### 3. Submit a video

```bash
curl -X POST http://localhost:8000/api/v1/jobs \
  -F "video=@/path/to/your/video.mp4"
```

Optional parameters:

| Parameter             | Default | Range      | Description                           |
| --------------------- | ------- | ---------- | ------------------------------------- |
| `output_format`       | `splat` | splat, ply | Output file format                    |
| `max_frames`          | `40`    | 8-80       | Max frames extracted from video       |
| `training_iterations` | `7000`  | 1000-30000 | gsplat training steps                 |
| `resolution`          | `768`   | 256-1920   | Training image resolution (long edge) |

Example with custom settings:

```bash
curl -X POST http://localhost:8000/api/v1/jobs \
  -F "video=@video.mp4" \
  -F "training_iterations=15000" \
  -F "resolution=1024"
```

### 4. Check job status

```bash
curl http://localhost:8000/api/v1/jobs/<job_id>
```

### 5. View the result

Open the renderer and load your splat:

```
http://localhost:9000?url=/jobs/<job_id>/output.splat
```

Or drag and drop the `.splat` file directly onto the renderer page.

## Tips for Good Results

- **Walk around the subject** - videos that orbit around an object work best
- **Steady movement** - avoid fast pans or shaky footage
- **Good lighting** - even lighting without harsh shadows
- **10-30 seconds** is usually enough; longer videos just add processing time
- **Increase iterations** to 15000-30000 for higher quality (at the cost of time)
- **Increase resolution** to 1024 for more detail (uses more VRAM)

## API Reference

| Endpoint                       | Method | Description          |
| ------------------------------ | ------ | -------------------- |
| `/api/v1/health`               | GET    | Server & GPU status  |
| `/api/v1/jobs`                 | POST   | Submit a video       |
| `/api/v1/jobs/<job_id>`        | GET    | Check job status     |
| `/api/v1/jobs/<job_id>/result` | GET    | Download result file |
| `/api/v1/jobs/<job_id>`        | DELETE | Delete a job         |

## Pipeline

1. **Frame extraction** - FFmpeg pulls keyframes via scene-change detection, drops blurry frames
2. **Pose estimation** - DUSt3R estimates camera poses and a dense point cloud (runs at 512px internally)
3. **Training** - gsplat optimizes 3D Gaussians against the posed images (at the requested resolution)
4. **Conversion** - PLY is converted to `.splat` format for the WebGL viewer

## Configuration

All settings can be overridden with `SPLAT_` prefixed environment variables:

```bash
# GPU
SPLAT_GPU_DEVICE=cuda:0            # which GPU to use
SPLAT_MAX_GPU_MEMORY_FRACTION=0.9  # max VRAM usage fraction

# Training defaults
SPLAT_DEFAULT_TRAINING_ITERATIONS=7000
SPLAT_DEFAULT_RESOLUTION=768
SPLAT_DEFAULT_MAX_FRAMES=40

# Paths
SPLAT_JOBS_DIR=./jobs              # where job artifacts are stored
SPLAT_FFMPEG_PATH=ffmpeg           # path to ffmpeg binary
SPLAT_FFPROBE_PATH=ffprobe         # path to ffprobe binary

# Job management
SPLAT_MAX_UPLOAD_SIZE_MB=500
SPLAT_JOB_TTL_HOURS=24             # auto-cleanup after this many hours
```

## Renderer Controls

- **Arrow keys** - move forward/back, strafe left/right
- **WASD** - rotate camera
- **Mouse drag** - orbit
- **Right-click drag** - move forward/back and strafe
- **Scroll** - orbit / zoom
- **Space** - jump
- **P** - play default animation

See [`renderer/README.md`](renderer/README.md) for full controls.

## Project Structure

```
SimpleGaussianSplatServer/
├── server/                  # FastAPI processing server
│   ├── app.py               # API endpoints + job orchestration
│   ├── config.py            # Settings (env var overrides)
│   ├── models.py            # Request/response schemas
│   ├── pipeline/
│   │   ├── frames.py        # FFmpeg frame extraction
│   │   ├── poses.py         # DUSt3R pose estimation
│   │   ├── train.py         # gsplat 3DGS training
│   │   └── convert.py       # PLY → .splat conversion
│   └── utils/
│       ├── gpu.py            # GPU memory management
│       └── cleanup.py        # Job artifact cleanup
├── renderer/                # WebGL viewer (antimatter15/splat)
│   ├── index.html
│   ├── main.js
│   └── server.js            # Express static server
├── dust3r/                  # DUSt3R (cloned during setup, not in repo)
├── setup_env.sh             # Automated environment setup
└── README.md
```
