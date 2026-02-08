# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SplatApp is a video-to-3D-Gaussian-Splat platform. Users upload videos from a mobile app, a FastAPI server processes them through an ML pipeline (DUSt3R pose estimation + gsplat training), and a WebGL viewer renders the resulting 3D scenes.

## Architecture

Four services work together:

- **Server** (`server/`, port 8000) — FastAPI Python server that runs the GPU-intensive ML pipeline. Processes jobs through 4 stages: frame extraction (FFmpeg) → pose estimation (DUSt3R) → training (gsplat) → PLY-to-splat conversion. One GPU lock serializes all job execution. Job state is in-memory (non-persistent). When `SPLAT_QUEUE_URL` is set, it polls the render-queue for remote jobs instead of accepting direct uploads.

- **Render Queue** (`render-queue/`, Cloudflare Worker) — Hono.js TypeScript worker providing the public API. Stores videos/results in R2, job metadata in D1 (SQLite). Handles user auth (email + OAuth via JWT), job queuing, and the recommendation feed. The GPU server polls `/api/v1/worker/claim` to pick up jobs.

- **Web Viewer** (`web-viewer/`, port 9000) — Express.js static server hosting a WebGL Gaussian splat renderer (fork of antimatter15/splat). Loads splats via `?url=/jobs/{id}/output.splat`. No external JS dependencies.

- **Mobile App** (`mobile/`) — Expo SDK 54 React Native app with camera recording, video upload, job status polling, feed browsing, and likes. Three context providers: AuthContext (JWT in SecureStore), JobContext (polling), FeedContext (paginated feed).

### Data Flow

```
Mobile → Render Queue (R2 storage) → Server polls & claims job → Processes on GPU → Uploads result to R2 → Mobile/Web Viewer loads .splat
```

## Common Commands

### Server
```bash
conda activate splatapp
uvicorn server.app:app --host 0.0.0.0 --port 8000
```

### Web Viewer
```bash
cd web-viewer && npm start          # serves on port 9000
```

### Mobile App
```bash
cd mobile && npm start              # Expo dev server
cd mobile && npm run ios            # iOS simulator
cd mobile && npm run android        # Android emulator
```

### Render Queue (Cloudflare Worker)
```bash
cd render-queue && npm run dev      # local dev with wrangler
cd render-queue && npm run deploy   # deploy to Cloudflare
# Migrations: npm run migrate:remote, migrate:remote:v2, ..., migrate:remote:v5
```

### Health Check / Quick Test
```bash
curl http://localhost:8000/api/v1/health
curl -X POST http://localhost:8000/api/v1/jobs -F "video=@test.mp4"
curl http://localhost:8000/api/v1/jobs/<job_id>
```

## Key API Contracts

- `POST /api/v1/jobs` — FormData with `video` field + optional `training_iterations`, `resolution`, `max_frames`, `output_format`. Returns `{ job_id, status, message }`.
- `GET /api/v1/jobs/{id}` — Returns `{ job_id, status, stages[], error }`. Stages: `frame_extraction`, `pose_estimation`, `training`, `conversion`. Training detail format: `"step X/Y, loss=Z"`.
- Render queue worker routes (`/api/v1/worker/*`) use `WORKER_API_KEY` header auth.
- User auth uses JWT Bearer tokens (30-day expiry).

## Configuration

Server settings use `SPLAT_` prefixed env vars (see `server/config.py`). Key ones:
- `SPLAT_QUEUE_URL` / `SPLAT_QUEUE_API_KEY` — connect to render queue
- `SPLAT_GPU_DEVICE`, `SPLAT_MAX_GPU_MEMORY_FRACTION` — GPU control
- `SPLAT_JOBS_DIR` — job artifact storage (default: `./jobs`)

Render queue secrets (set via `wrangler secret put`): `WORKER_API_KEY`, `JWT_SECRET`, `GOOGLE_CLIENT_ID`, `APPLE_BUNDLE_ID`.

Mobile config is in `mobile/src/config.js` — hardcoded `API_BASE` (Cloudflare worker URL) and `RENDERER_URL` (local IP `192.168.50.75:9000`).

## Mobile App Gotchas

- Use `CameraView` from expo-camera (not legacy `Camera` component)
- `expo-image-picker`: use `mediaTypes: 'videos'` (string, not enum)
- FormData uploads: do NOT set Content-Type header manually (let the runtime set multipart boundary)
- WebView: never wrap in ScrollView (breaks touch gestures), use `androidLayerType="hardware"` for WebGL
- iOS needs `NSAllowsArbitraryLoads: true` in app.json for HTTP connections
- Android needs `usesCleartextTraffic: true` for HTTP connections

## Database (D1)

Schema lives in `render-queue/migrations/` (5 migration files). Key tables:
- `jobs` — status enum: `queued` → `claimed` → `processing` → `completed`/`failed`
- `users` — email/password (argon2) + OAuth (Google/Apple)
- `likes` — many-to-many (user_id, job_id)

## Pipeline Details

The ML pipeline in `server/pipeline/` is the core of the project:
- `frames.py` — FFmpeg scene-change keyframe extraction + OpenCV Laplacian blur filtering
- `poses.py` — DUSt3R ViT-Large model (cached globally after first load, ~3.5GB). Returns camera poses (N,4,4), intrinsics, point cloud, colors.
- `train.py` — gsplat Gaussian optimization. Loss: SSIM + L1 + L2 regularization. Densification via gradient-based splitting/cloning.
- `convert.py` — PLY to .splat binary (32 bytes/gaussian, sorted by importance)

DUSt3R must be cloned to `./dust3r/` at the repo root (not included in git).
