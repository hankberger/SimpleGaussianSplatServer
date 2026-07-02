import asyncio
import logging
import shutil
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from splatworker.config import settings
from splatworker.models import (
    HealthResponse,
    JobConfig,
    JobResponse,
    JobStatus,
    JobStatusResponse,
    OutputFormat,
    StageProgress,
)
from splatworker.utils.cleanup import cleanup_job_dir, periodic_cleanup, remove_job_dir
from splatworker.utils.gpu import get_gpu_memory_info

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="SplatApp v2 Worker (COLMAP/DUSt3R → LichtFeld MRNF)", version="2.0.0")

# Allow browser clients (the local benchmark viewer) to call the worker directly.
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

# In-memory job store + single GPU lock (one job at a time).
jobs: dict[str, dict] = {}
gpu_lock = asyncio.Lock()


@app.on_event("startup")
async def startup():
    settings.jobs_dir.mkdir(parents=True, exist_ok=True)
    asyncio.create_task(periodic_cleanup(jobs))
    logger.info("Worker started. Jobs dir: %s", settings.jobs_dir.resolve())
    logger.info("Trainer: %s (strategy=%s)", settings.lichtfeld_bin, settings.lichtfeld_strategy)

    if settings.queue_url:
        from splatworker.queue_client import QueueClient

        queue_client = QueueClient()
        asyncio.create_task(queue_client.run(process_remote_job, gpu_lock))
        logger.info("Queue polling enabled: %s", settings.queue_url)


# --- Endpoints ---


@app.get("/api/v1/health", response_model=HealthResponse)
async def health():
    gpu = get_gpu_memory_info()
    active = sum(1 for j in jobs.values() if j["status"] == JobStatus.PROCESSING)
    queued = sum(1 for j in jobs.values() if j["status"] == JobStatus.QUEUED)
    return HealthResponse(
        status="ok" if gpu.get("available") else "no_gpu",
        gpu_name=gpu.get("name"),
        gpu_memory_total_mb=gpu.get("total_mb"),
        gpu_memory_used_mb=gpu.get("used_mb"),
        gpu_memory_free_mb=gpu.get("free_mb"),
        active_jobs=active,
        queued_jobs=queued,
    )


@app.get("/api/v1/config")
async def get_config():
    """Effective pipeline config, surfaced so clients (the benchmark) can record
    WHICH settings produced a result — matcher, strategy, cleanup, and the
    server-side defaults applied when a request omits params."""
    return {
        "pose_backend_primary": "colmap" if settings.colmap_enabled else "dust3r",
        "colmap_matcher": settings.colmap_matcher,
        "colmap_camera_model": settings.colmap_camera_model,
        "lichtfeld_strategy": settings.lichtfeld_strategy,
        "lichtfeld_max_cap": settings.lichtfeld_max_cap,
        "lichtfeld_sh_degree": settings.lichtfeld_sh_degree,
        "cleanup_enabled": settings.cleanup_enabled,
        "drop_blurry": settings.drop_blurry,
        "default_max_frames": settings.default_max_frames,
        "default_resolution": settings.default_resolution,
        "default_training_iterations": settings.default_training_iterations,
    }


@app.post("/api/v1/jobs", response_model=JobResponse)
async def create_job(
    video: UploadFile = File(...),
    output_format: OutputFormat = Form(default=OutputFormat.SPLAT),
    # Default to None so an omitted field falls back to settings.default_* — this
    # is what the benchmark's "use worker defaults" toggle relies on.
    max_frames: int | None = Form(default=None, ge=8, le=300),
    training_iterations: int | None = Form(default=None, ge=1000, le=100000),
    resolution: int | None = Form(default=None, ge=256, le=3840),
):
    if max_frames is None:
        max_frames = settings.default_max_frames
    if training_iterations is None:
        training_iterations = settings.default_training_iterations
    if resolution is None:
        resolution = settings.default_resolution
    resolution = max(256, min(3840, (resolution // 64) * 64))

    content = await video.read()
    size_mb = len(content) / (1024 * 1024)
    if size_mb > settings.max_upload_size_mb:
        raise HTTPException(413, f"File too large: {size_mb:.0f}MB (max {settings.max_upload_size_mb}MB)")

    job_id = uuid.uuid4().hex[:12]
    job_dir = settings.jobs_dir / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    video_ext = Path(video.filename).suffix if video.filename else ".mp4"
    video_path = job_dir / f"input{video_ext}"
    video_path.write_bytes(content)

    config = JobConfig(
        output_format=output_format,
        max_frames=max_frames,
        training_iterations=training_iterations,
        resolution=resolution,
    )

    now = datetime.now(timezone.utc)
    jobs[job_id] = {
        "status": JobStatus.QUEUED,
        "created_at": now,
        "created_at_ts": time.time(),
        "config": config,
        "video_path": str(video_path),
        "job_dir": str(job_dir),
        "stages": _new_stages(),
        "error": None,
        "result_path": None,
    }

    asyncio.create_task(process_job(job_id))
    logger.info("Job %s created (%.1f MB, %s)", job_id, size_mb, config)
    return JobResponse(job_id=job_id, status=JobStatus.QUEUED, message="Job queued for processing")


@app.get("/api/v1/jobs/{job_id}", response_model=JobStatusResponse)
async def get_job_status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    return JobStatusResponse(
        job_id=job_id,
        status=job["status"],
        created_at=job["created_at"],
        stages=[StageProgress(**s) for s in job["stages"]],
        error=job.get("error"),
        result_format=job["config"].output_format if job["status"] == JobStatus.COMPLETED else None,
    )


@app.get("/api/v1/jobs/{job_id}/result")
async def get_job_result(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    if job["status"] != JobStatus.COMPLETED:
        raise HTTPException(400, f"Job not completed (status: {job['status'].value})")
    result_path = Path(job["result_path"])
    if not result_path.exists():
        raise HTTPException(404, "Result file not found")
    media_type = "application/octet-stream" if result_path.suffix == ".splat" else "application/x-ply"
    return FileResponse(
        path=str(result_path), filename=result_path.name, media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{result_path.name}"'},
    )


@app.get("/api/v1/jobs/{job_id}/dataset")
async def get_job_dataset(job_id: str):
    """Download the COLMAP dataset (images + sparse model) for debugging — reload
    it into LichtFeld to bisect dataset quality vs training."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    zip_path = Path(jobs[job_id]["job_dir"]) / "colmap_dataset.zip"
    if not zip_path.exists():
        raise HTTPException(404, "No dataset zip (job not finished or export disabled)")
    return FileResponse(
        path=str(zip_path), filename=f"colmap_dataset_{job_id}.zip", media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="colmap_dataset_{job_id}.zip"'},
    )


@app.get("/api/v1/jobs/{job_id}/preview")
async def get_job_preview(job_id: str, format: str = "webp"):
    """Serve the rendered scene preview. format=webp (default) or png."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    ext = "png" if format == "png" else "webp"
    preview_path = Path(jobs[job_id]["job_dir"]) / f"preview.{ext}"
    if not preview_path.exists():
        raise HTTPException(404, "Preview not available")
    media_type = "image/png" if ext == "png" else "image/webp"
    return FileResponse(path=str(preview_path), media_type=media_type)


@app.delete("/api/v1/jobs/{job_id}")
async def delete_job(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs.pop(job_id)
    remove_job_dir(Path(job["job_dir"]))
    return {"message": "Job deleted", "job_id": job_id}


# --- Pipeline orchestration ---


def _new_stages() -> list[dict]:
    return [
        {"name": "frame_extraction", "status": "pending"},
        {"name": "pose_estimation", "status": "pending"},
        {"name": "training", "status": "pending"},
        {"name": "cleanup", "status": "pending"},
        {"name": "conversion", "status": "pending"},
    ]


def _update_stage(job_id: str, name: str, status: str, detail: str | None = None):
    if job_id not in jobs:
        return
    for stage in jobs[job_id]["stages"]:
        if stage["name"] == name:
            stage["status"] = status
            if detail:
                stage["detail"] = detail
            break


async def process_job(job_id: str):
    """Run the full video→splat pipeline for a direct-upload job."""
    job = jobs.get(job_id)
    if not job:
        return

    async with gpu_lock:
        job["status"] = JobStatus.PROCESSING
        config: JobConfig = job["config"]
        job_dir = Path(job["job_dir"])
        video_path = Path(job["video_path"])

        def stage(name, status, detail=None):
            _update_stage(job_id, name, status, detail)

        def on_progress(step, loss):
            _update_stage(job_id, "training", "running",
                          f"step {step}/{config.training_iterations}, loss={loss:.4f}")

        try:
            await _run_pipeline(job_dir, video_path, config, stage, on_progress, job)
            job["status"] = JobStatus.COMPLETED
            logger.info("Job %s completed: %s", job_id, job["result_path"])
        except Exception as e:
            logger.exception("Job %s failed", job_id)
            job["status"] = JobStatus.FAILED
            job["error"] = str(e)
            for s in job["stages"]:
                if s["status"] in ("pending", "running"):
                    s["status"] = "failed"


async def process_remote_job(job_id, video_path, job_dir, config, stages, report_stages):
    """Run the pipeline for a remote queue job. Called by QueueClient."""

    def stage(name, status, detail=None):
        for s in stages:
            if s["name"] == name:
                s["status"] = status
                if detail:
                    s["detail"] = detail
                break
        asyncio.run_coroutine_threadsafe(report_stages(), loop)

    loop = asyncio.get_event_loop()
    last_report = [0.0]

    def on_progress(step, loss):
        for s in stages:
            if s["name"] == "training":
                s["status"] = "running"
                s["detail"] = f"step {step}/{config.training_iterations}, loss={loss:.4f}"
        now = time.time()
        if now - last_report[0] > 5:
            last_report[0] = now
            asyncio.run_coroutine_threadsafe(report_stages(), loop)

    async with gpu_lock:
        result_path = await _run_pipeline(job_dir, video_path, config, stage, on_progress, {})
        await report_stages()
        return result_path


async def _run_pipeline(job_dir, video_path, config, stage, on_progress, job):
    """Shared pipeline body for both direct and queue jobs. Returns result_path."""
    # Stage 1: Frame extraction
    stage("frame_extraction", "running")
    frames, n_soft = await asyncio.to_thread(_run_frame_extraction, video_path, job_dir, config)
    stage("frame_extraction", "completed", f"{len(frames)} frames ({n_soft} soft)")

    # Stage 2: Pose estimation → COLMAP-format dataset (COLMAP primary, DUSt3R fallback)
    stage("pose_estimation", "running")
    pose = await asyncio.to_thread(_run_pose_estimation, frames, job_dir, config)
    stage("pose_estimation", "completed",
          f"{pose['backend']}: {pose['registered']}/{pose['total']} cams, {pose['points']} pts")

    # Stage 3: Training (LichtFeld MRNF)
    stage("training", "running")
    train_out = job_dir / "train_out"
    raw_ply = await asyncio.to_thread(
        _run_training, pose["dataset_dir"], train_out, config.training_iterations, on_progress
    )
    stage("training", "completed")

    # Move the trained PLY to the canonical job output location.
    ply_path = job_dir / "output.ply"
    shutil.move(str(raw_ply), str(ply_path))

    # Stage 4: Cleanup — prune low-confidence Gaussians (in place)
    stage("cleanup", "running")
    ply_path, cleanup_stats = await asyncio.to_thread(_run_cleanup, ply_path)
    stage("cleanup", "completed", _cleanup_detail(cleanup_stats))

    # Preview (non-fatal, not a tracked stage) — render from the cleaned PLY.
    await asyncio.to_thread(_run_preview, ply_path, pose["dataset_dir"], job_dir)

    # Stage 5: Conversion (PLY → .splat if requested)
    stage("conversion", "running")
    result_path = await asyncio.to_thread(_run_conversion, ply_path, config)
    stage("conversion", "completed")

    if job is not None:
        job["result_path"] = str(result_path)
    cleanup_job_dir(job_dir, keep_result=True)
    return result_path


def _run_frame_extraction(video_path: Path, job_dir: Path, config: JobConfig):
    from splatworker.pipeline.frames import extract_frames, normalize_video, select_sharp_frames

    frames_dir = job_dir / "frames"
    try:
        frame_paths = extract_frames(video_path, frames_dir, config.max_frames, config.resolution)
        if len(frame_paths) < settings.min_frames:
            raise RuntimeError(f"only {len(frame_paths)} frames extracted (< {settings.min_frames})")
    except Exception as e:
        logger.warning("Direct frame extraction failed (%s); normalizing and retrying", e)
        for f in frames_dir.glob("frame_*.png"):
            f.unlink(missing_ok=True)
        normalized = normalize_video(video_path)
        frame_paths = extract_frames(normalized, frames_dir, config.max_frames, config.resolution)

    frames, n_soft = select_sharp_frames(
        frame_paths, drop=settings.drop_blurry,
        drop_ratio=settings.blur_drop_ratio, min_keep=settings.min_frames_after_blur,
    )
    return frames, n_soft


def _run_pose_estimation(frames, job_dir: Path, config: JobConfig):
    from splatworker.pipeline.poses import estimate_poses

    return estimate_poses(frames, job_dir, config)


def _run_training(dataset_dir: Path, output_dir: Path, iterations: int, progress_cb):
    from splatworker.pipeline.train import train

    return train(dataset_dir, output_dir, iterations, progress_cb)


def _run_cleanup(ply_path: Path):
    if not settings.cleanup_enabled:
        return ply_path, {"skipped": True}
    from splatworker.pipeline.cleanup import clean_ply

    return clean_ply(ply_path)


def _run_preview(ply_path: Path, dataset_dir: Path, job_dir: Path):
    from splatworker.pipeline.preview import render_preview

    return render_preview(ply_path, dataset_dir, job_dir)


def _run_conversion(ply_path: Path, config: JobConfig) -> Path:
    if config.output_format == OutputFormat.PLY:
        return ply_path
    from splatworker.pipeline.convert import ply_to_splat

    return ply_to_splat(ply_path, ply_path.with_suffix(".splat"))


def _cleanup_detail(stats: dict) -> str:
    if stats.get("skipped"):
        return "skipped"
    n0 = stats.get("input", 0)
    removed = stats.get("removed", 0)
    pct = (removed / n0 * 100) if n0 else 0.0
    return f"{stats.get('kept', n0)} kept, pruned {removed} ({pct:.0f}%)"
