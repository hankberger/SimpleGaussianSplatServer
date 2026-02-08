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
from fastapi.responses import FileResponse

from server.config import settings
from server.models import (
    HealthResponse,
    JobConfig,
    JobResponse,
    JobStatus,
    JobStatusResponse,
    OutputFormat,
    StageProgress,
)
from server.utils.cleanup import cleanup_job_dir, periodic_cleanup, remove_job_dir
from server.utils.gpu import get_gpu_memory_info

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="SplatApp Video-to-Splat Server", version="1.0.0")

# In-memory job store
jobs: dict[str, dict] = {}

# GPU lock: one job at a time on a single GPU
gpu_lock = asyncio.Lock()


@app.on_event("startup")
async def startup():
    settings.jobs_dir.mkdir(parents=True, exist_ok=True)
    asyncio.create_task(periodic_cleanup(jobs))
    logger.info("Server started. Jobs dir: %s", settings.jobs_dir.resolve())


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
    max_frames: int = Form(default=40, ge=8, le=80),
    training_iterations: int = Form(default=7000, ge=1000, le=30000),
    resolution: int = Form(default=768, ge=256, le=1920),
):
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
            # Stage 1: Frame extraction
            _update_stage(job_id, "frame_extraction", "running")
            frame_paths = await asyncio.to_thread(
                _run_frame_extraction, video_path, job_dir, config
            )
            _update_stage(
                job_id,
                "frame_extraction",
                "completed",
                f"{len(frame_paths)} frames",
            )

            # Stage 2: Pose estimation
            _update_stage(job_id, "pose_estimation", "running")
            poses, intrinsics, points, colors = await asyncio.to_thread(
                _run_pose_estimation, frame_paths, config
            )
            _update_stage(
                job_id,
                "pose_estimation",
                "completed",
                f"{len(points)} points, {len(poses)} poses",
            )

            # Rescale intrinsics from DUSt3R resolution to training resolution
            if config.resolution != settings.dust3r_resolution:
                import numpy as np
                scale = config.resolution / settings.dust3r_resolution
                intrinsics = intrinsics.copy()
                intrinsics[:, 0, :] *= scale  # fx, skew, cx
                intrinsics[:, 1, :] *= scale  # fy, cy
                # Row 2 stays [0, 0, 1]
                intrinsics[:, 2, :] = [0, 0, 1]
                logger.info(
                    "Rescaled intrinsics: DUSt3R %d -> training %d (scale=%.2f)",
                    settings.dust3r_resolution, config.resolution, scale,
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

            ply_path = await asyncio.to_thread(
                _run_training,
                points,
                colors,
                poses,
                intrinsics,
                frame_paths,
                config,
                on_progress,
            )
            _update_stage(job_id, "training", "completed")

            # Stage 4: Conversion (if splat format requested)
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


def _run_frame_extraction(video_path: Path, job_dir: Path, config: JobConfig) -> list[Path]:
    from server.pipeline.frames import extract_frames, filter_blurry_frames

    frames_dir = job_dir / "frames"
    frame_paths = extract_frames(
        video_path, frames_dir, config.max_frames, config.resolution
    )
    frame_paths = filter_blurry_frames(frame_paths)
    return frame_paths


def _run_pose_estimation(frame_paths: list[Path], config: JobConfig):
    from server.pipeline.poses import estimate_poses

    # DUSt3R always runs at its own fixed resolution (512) for best accuracy
    return estimate_poses(frame_paths, settings.dust3r_resolution)


def _run_training(points, colors, poses, intrinsics, frame_paths, config: JobConfig, progress_cb):
    from server.pipeline.train import train_gaussians

    return train_gaussians(
        points, colors, poses, intrinsics, frame_paths,
        max_steps=config.training_iterations,
        progress_cb=progress_cb,
    )


def _run_conversion(ply_path: Path, config: JobConfig) -> Path:
    if config.output_format == OutputFormat.PLY:
        return ply_path

    from server.pipeline.convert import ply_to_splat

    splat_path = ply_path.with_suffix(".splat")
    return ply_to_splat(ply_path, splat_path)
