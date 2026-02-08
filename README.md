# SplatApp

Video-to-Gaussian-Splat pipeline with a WebGL viewer. Upload a video, get back a navigable 3D scene.

## Quick Start

### 1. Start the processing server

```bash
cd server
uvicorn server.app:app --host 0.0.0.0 --port 8000
```

### 2. Start the renderer

```bash
cd renderer
npm install
npm start
```

The renderer runs at **http://localhost:9000**.

### 3. Submit a video

```bash
curl -X POST http://localhost:8000/api/v1/jobs \
  -F "video=@/path/to/your/video.mp4"
```

Optional parameters:

| Parameter              | Default | Range       | Description                          |
|------------------------|---------|-------------|--------------------------------------|
| `output_format`        | `splat` | splat, ply  | Output file format                   |
| `max_frames`           | `40`    | 8-80        | Max frames extracted from video      |
| `training_iterations`  | `7000`  | 1000-30000  | gsplat training steps                |
| `resolution`           | `768`   | 256-1920    | Training image resolution (long edge)|

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

## API Reference

| Endpoint                          | Method | Description            |
|-----------------------------------|--------|------------------------|
| `/api/v1/health`                  | GET    | Server & GPU status    |
| `/api/v1/jobs`                    | POST   | Submit a video         |
| `/api/v1/jobs/<job_id>`           | GET    | Check job status       |
| `/api/v1/jobs/<job_id>/result`    | GET    | Download result file   |
| `/api/v1/jobs/<job_id>`           | DELETE | Delete a job           |

## Pipeline

1. **Frame extraction** - FFmpeg pulls keyframes via scene-change detection, drops blurry frames
2. **Pose estimation** - DUSt3R estimates camera poses and a dense point cloud
3. **Training** - gsplat optimizes 3D Gaussians against the posed images
4. **Conversion** - PLY is converted to `.splat` format for the WebGL viewer

## Renderer Controls

- **Arrow keys** - move forward/back, strafe left/right
- **WASD** - rotate camera
- **Mouse drag** - orbit
- **Right-click drag** - move forward/back and strafe
- **Scroll** - orbit / zoom
- **Space** - jump
- **P** - play default animation

See [`renderer/README.md`](renderer/README.md) for full controls.

## Environment Variables

All settings can be overridden with `SPLAT_` prefixed env vars:

```bash
SPLAT_GPU_DEVICE=cuda:0
SPLAT_DEFAULT_TRAINING_ITERATIONS=7000
SPLAT_DEFAULT_RESOLUTION=768
SPLAT_JOBS_DIR=./jobs
```
