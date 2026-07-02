import asyncio
import logging
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Add dust3r repo to Python path so its modules are importable
_dust3r_path = str(Path(__file__).resolve().parent.parent / "dust3r")
if _dust3r_path not in sys.path:
    sys.path.insert(0, _dust3r_path)

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from worker.config import settings
from worker.models import (
    HealthResponse,
    JobConfig,
    JobResponse,
    JobStatus,
    JobStatusResponse,
    OutputFormat,
    StageProgress,
)
from worker.utils.cleanup import cleanup_job_dir, periodic_cleanup, remove_job_dir
from worker.utils.gpu import get_gpu_memory_info

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="SplatApp Video-to-Splat Server", version="1.0.0")

# Allow browser clients (e.g. the local benchmark viewer) to call the worker
# directly. No credentials are used, so a wildcard origin is safe here.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory job store
jobs: dict[str, dict] = {}

# GPU lock: one job at a time on a single GPU
gpu_lock = asyncio.Lock()


@app.on_event("startup")
async def startup():
    settings.jobs_dir.mkdir(parents=True, exist_ok=True)
    asyncio.create_task(periodic_cleanup(jobs))
    logger.info("Server started. Jobs dir: %s", settings.jobs_dir.resolve())

    # If queue URL is configured, start polling for remote jobs
    if settings.queue_url:
        from worker.queue_client import QueueClient

        queue_client = QueueClient()
        # Pass the GPU lock so the client pauses claims while a job is processing.
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


@app.post("/api/v1/jobs", response_model=JobResponse)
async def create_job(
    video: UploadFile = File(...),
    output_format: OutputFormat = Form(default=OutputFormat.SPLAT),
    # Default to None so an omitted field falls back to the configured default
    # (settings.default_*), not a hardcoded value. This is what the benchmark's
    # "use worker defaults" toggle relies on to actually get the tuned config.
    max_frames: int | None = Form(default=None, ge=8, le=200),
    training_iterations: int | None = Form(default=None, ge=1000, le=30000),
    resolution: int | None = Form(default=None, ge=256, le=1920),
):
    if max_frames is None:
        max_frames = settings.default_max_frames
    if training_iterations is None:
        training_iterations = settings.default_training_iterations
    if resolution is None:
        resolution = settings.default_resolution

    # Clamp to nearest multiple of 64 for GPU efficiency
    resolution = max(256, min(1920, (resolution // 64) * 64))

    # Check file size
    content = await video.read()
    size_mb = len(content) / (1024 * 1024)
    if size_mb > settings.max_upload_size_mb:
        raise HTTPException(413, f"File too large: {size_mb:.0f}MB (max {settings.max_upload_size_mb}MB)")

    # Create job
    job_id = uuid.uuid4().hex[:12]
    job_dir = settings.jobs_dir / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    # Save video
    video_ext = Path(video.filename).suffix if video.filename else ".mp4"
    video_path = job_dir / f"input{video_ext}"
    with open(video_path, "wb") as f:
        f.write(content)

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
        "stages": [
            {"name": "frame_extraction", "status": "pending"},
            {"name": "pose_estimation", "status": "pending"},
            {"name": "training", "status": "pending"},
            {"name": "cleanup", "status": "pending"},
            {"name": "conversion", "status": "pending"},
        ],
        "error": None,
        "result_path": None,
    }

    # Launch processing in background
    asyncio.create_task(process_job(job_id))
    logger.info("Job %s created (%.1f MB, %s)", job_id, size_mb, config)

    return JobResponse(
        job_id=job_id,
        status=JobStatus.QUEUED,
        message="Job queued for processing",
    )


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

    media_type = (
        "application/octet-stream"
        if result_path.suffix == ".splat"
        else "application/x-ply"
    )
    return FileResponse(
        path=str(result_path),
        filename=result_path.name,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{result_path.name}"'},
    )


@app.get("/api/v1/jobs/{job_id}/dataset")
async def get_job_dataset(job_id: str):
    """Download the COLMAP dataset (images + sparse model) for debugging —
    bisect COLMAP vs training by loading it into another trainer. Only present
    when the COLMAP backend ran (not DUSt3R) and colmap_save_dataset is on."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    zip_path = Path(jobs[job_id]["job_dir"]) / "colmap_dataset.zip"
    if not zip_path.exists():
        raise HTTPException(
            404, "No COLMAP dataset (DUSt3R fallback ran, or job not finished)"
        )
    return FileResponse(
        path=str(zip_path),
        filename=f"colmap_dataset_{job_id}.zip",
        media_type="application/zip",
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


def _update_stage(job_id: str, stage_name: str, status: str, detail: str | None = None):
    """Update a pipeline stage's status."""
    if job_id not in jobs:
        return
    for stage in jobs[job_id]["stages"]:
        if stage["name"] == stage_name:
            stage["status"] = status
            if detail:
                stage["detail"] = detail
            break


async def process_job(job_id: str):
    """Run the full video-to-splat pipeline for a job."""
    job = jobs.get(job_id)
    if not job:
        return

    # Wait for GPU lock (serializes GPU work)
    async with gpu_lock:
        job["status"] = JobStatus.PROCESSING
        config: JobConfig = job["config"]
        job_dir = Path(job["job_dir"])
        video_path = Path(job["video_path"])

        try:
            # Stage 1: Frame extraction. all_frames = full evenly-spaced set (for
            # COLMAP); sharp_frames = blur-filtered subset (for training).
            _update_stage(job_id, "frame_extraction", "running")
            all_frames, sharp_frames = await asyncio.to_thread(
                _run_frame_extraction, video_path, job_dir, config
            )
            _update_stage(
                job_id,
                "frame_extraction",
                "completed",
                f"{len(sharp_frames)}/{len(all_frames)} sharp frames",
            )

            # Stage 2: Pose estimation (COLMAP primary, DUSt3R fallback). COLMAP
            # registers the full set then filters to sharp; it returns the actual
            # (sharp, registered) frames, so rebind frame_paths to stay aligned
            # with the poses. Intrinsics come back at the training resolution.
            _update_stage(job_id, "pose_estimation", "running")
            poses, intrinsics, points, colors, frame_paths, backend = await asyncio.to_thread(
                _run_pose_estimation, all_frames, sharp_frames, config
            )
            _update_stage(
                job_id,
                "pose_estimation",
                "completed",
                f"{backend}: {len(points)} points, {len(poses)} cameras",
            )

            # Stage 3: Training
            _update_stage(job_id, "training", "running")

            def on_progress(step: int, loss: float):
                _update_stage(
                    job_id,
                    "training",
                    "running",
                    f"step {step}/{config.training_iterations}, loss={loss:.4f}",
                )

            # Refine poses only for DUSt3R (approximate); COLMAP poses are
            # accurate and refining them warps the scene.
            refine_poses = settings.pose_opt_enabled and backend == "dust3r"
            ply_path = await asyncio.to_thread(
                _run_training,
                points,
                colors,
                poses,
                intrinsics,
                frame_paths,
                config,
                on_progress,
                job_dir,
                refine_poses,
            )
            _update_stage(job_id, "training", "completed")

            # Stage 4: Cleanup — prune low-confidence Gaussians from the PLY
            _update_stage(job_id, "cleanup", "running")
            ply_path, cleanup_stats = await asyncio.to_thread(_run_cleanup, ply_path)
            _update_stage(job_id, "cleanup", "completed", _cleanup_detail(cleanup_stats))

            # Stage 5: Conversion (if splat format requested)
            _update_stage(job_id, "conversion", "running")
            result_path = await asyncio.to_thread(
                _run_conversion, ply_path, config
            )
            _update_stage(job_id, "conversion", "completed")

            # Done
            job["status"] = JobStatus.COMPLETED
            job["result_path"] = str(result_path)
            logger.info("Job %s completed: %s", job_id, result_path)

            # Clean up intermediate files
            cleanup_job_dir(job_dir, keep_result=True)

        except Exception as e:
            logger.exception("Job %s failed", job_id)
            job["status"] = JobStatus.FAILED
            job["error"] = str(e)

            # Mark remaining stages as failed
            for stage in job["stages"]:
                if stage["status"] in ("pending", "running"):
                    stage["status"] = "failed"


async def process_remote_job(
    job_id: str,
    video_path: Path,
    job_dir: Path,
    config: JobConfig,
    stages: list[dict],
    report_stages,
):
    """Run the pipeline for a remote queue job. Called by QueueClient."""

    def update_stage(stage_name: str, status: str, detail: str | None = None):
        for s in stages:
            if s["name"] == stage_name:
                s["status"] = status
                if detail:
                    s["detail"] = detail
                break

    async with gpu_lock:
        # Stage 1: Frame extraction
        update_stage("frame_extraction", "running")
        await report_stages()
        all_frames, sharp_frames = await asyncio.to_thread(
            _run_frame_extraction, video_path, job_dir, config
        )
        update_stage(
            "frame_extraction", "completed",
            f"{len(sharp_frames)}/{len(all_frames)} sharp frames",
        )
        await report_stages()

        # Stage 2: Pose estimation (COLMAP primary, DUSt3R fallback). COLMAP runs
        # on the full set then filters to sharp; it returns the actual (sharp,
        # registered) frames, so rebind frame_paths to stay aligned with the poses.
        update_stage("pose_estimation", "running")
        await report_stages()
        poses, intrinsics, points, colors, frame_paths, backend = await asyncio.to_thread(
            _run_pose_estimation, all_frames, sharp_frames, config
        )
        update_stage(
            "pose_estimation", "completed",
            f"{backend}: {len(points)} points, {len(poses)} cameras",
        )
        await report_stages()

        # Stage 3: Training
        update_stage("training", "running")
        await report_stages()

        last_report = [0.0]
        loop = asyncio.get_event_loop()

        def on_progress(step: int, loss: float):
            import time

            update_stage(
                "training",
                "running",
                f"step {step}/{config.training_iterations}, loss={loss:.4f}",
            )
            # Throttle status reports to avoid hammering the API
            now = time.time()
            if now - last_report[0] > 5:
                last_report[0] = now
                asyncio.run_coroutine_threadsafe(report_stages(), loop)

        refine_poses = settings.pose_opt_enabled and backend == "dust3r"
        ply_path = await asyncio.to_thread(
            _run_training, points, colors, poses, intrinsics, frame_paths, config, on_progress, job_dir, refine_poses
        )
        update_stage("training", "completed")
        await report_stages()

        # Stage 4: Cleanup — prune low-confidence Gaussians from the PLY
        update_stage("cleanup", "running")
        await report_stages()
        ply_path, cleanup_stats = await asyncio.to_thread(_run_cleanup, ply_path)
        update_stage("cleanup", "completed", _cleanup_detail(cleanup_stats))
        await report_stages()

        # Stage 5: Conversion
        update_stage("conversion", "running")
        await report_stages()
        result_path = await asyncio.to_thread(_run_conversion, ply_path, config)
        update_stage("conversion", "completed")
        await report_stages()

        # Clean up intermediate files
        cleanup_job_dir(job_dir, keep_result=True)

        return result_path


def _run_frame_extraction(video_path: Path, job_dir: Path, config: JobConfig):
    """Returns (all_frames, sharp_frames). all_frames is the full evenly-spaced
    extraction (kept on disk so COLMAP's sequential matcher sees even spacing);
    sharp_frames is the blur-filtered subset that TRAINING uses."""
    from worker.pipeline.frames import extract_frames, filter_blurry_frames, normalize_video

    frames_dir = job_dir / "frames"

    # Extract directly from the source. ffmpeg decodes HEVC/.MOV/etc. natively,
    # so the CPU-bound full re-encode (normalize_video) is only a fallback for
    # inputs that won't decode or yield too few frames — avoiding a whole extra
    # transcode pass over the file on every job.
    try:
        frame_paths = extract_frames(
            video_path, frames_dir, config.max_frames, config.resolution
        )
        if len(frame_paths) < settings.min_frames:
            raise RuntimeError(
                f"only {len(frame_paths)} frames extracted (< {settings.min_frames})"
            )
    except Exception as e:
        logger.warning("Direct frame extraction failed (%s); normalizing and retrying", e)
        for f in frames_dir.glob("frame_*.png"):
            f.unlink(missing_ok=True)
        normalized = normalize_video(video_path)
        frame_paths = extract_frames(
            normalized, frames_dir, config.max_frames, config.resolution
        )

    # filter_blurry_frames no longer deletes — the softer frames stay on disk for
    # COLMAP; only the sharp subset is used for training.
    sharp_frames = filter_blurry_frames(frame_paths)
    return frame_paths, sharp_frames


def _run_pose_estimation(all_frames, sharp_frames, config: JobConfig):
    from worker.pipeline.poses import estimate_poses

    # Dispatches to COLMAP (primary) or DUSt3R (fallback). COLMAP estimates poses
    # on the full evenly-spaced set, then the result is filtered to sharp_frames
    # for training. Returns poses, intrinsics, points, colors, the (sharp,
    # registered) frame subset, and the backend name.
    return estimate_poses(all_frames, sharp_frames, config)


def _run_training(points, colors, poses, intrinsics, frame_paths, config: JobConfig, progress_cb, output_dir, optimize_poses):
    from worker.pipeline.train import train_gaussians

    return train_gaussians(
        points, colors, poses, intrinsics, frame_paths,
        max_steps=config.training_iterations,
        progress_cb=progress_cb,
        output_dir=output_dir,
        optimize_poses=optimize_poses,
    )


def _run_cleanup(ply_path: Path):
    """Prune low-confidence Gaussians from the trained PLY (in place)."""
    if not settings.cleanup_enabled:
        return ply_path, {"skipped": True}

    from worker.pipeline.cleanup import clean_ply

    return clean_ply(ply_path)


def _cleanup_detail(stats: dict) -> str:
    """Human-readable summary of a cleanup pass for the stage detail field."""
    if stats.get("skipped"):
        return "skipped"
    n0 = stats.get("input", 0)
    removed = stats.get("removed", 0)
    pct = (removed / n0 * 100) if n0 else 0.0
    return f"{stats.get('kept', n0)} kept, pruned {removed} ({pct:.0f}%)"


def _run_conversion(ply_path: Path, config: JobConfig) -> Path:
    if config.output_format == OutputFormat.PLY:
        return ply_path

    from worker.pipeline.convert import ply_to_splat

    splat_path = ply_path.with_suffix(".splat")
    return ply_to_splat(ply_path, splat_path)
