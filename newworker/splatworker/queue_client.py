"""Queue client that polls the Cloudflare render-queue Worker for jobs.

When SPLAT_QUEUE_URL is configured, this polls for queued jobs, downloads the
video, runs the pipeline, reports progress, and uploads the result + preview —
identical protocol to the v1 worker, so it drops into the existing render-queue.
"""

import asyncio
import logging
from pathlib import Path

import httpx

from splatworker.config import settings
from splatworker.models import JobConfig, OutputFormat

logger = logging.getLogger(__name__)


class QueueClient:
    def __init__(self):
        self.base_url = settings.queue_url.rstrip("/")
        self.headers = {"Authorization": f"Bearer {settings.queue_api_key}"}
        self.poll_interval = settings.queue_poll_interval

    async def run(self, process_job_fn, gpu_lock=None):
        """Main polling loop. Runs forever as a background task.

        gpu_lock: while held (a job is running the pipeline) we skip claiming, so
        we don't mark a queue job "processing" and download its video only to
        block on the GPU. Claims resume once the GPU is free.
        """
        logger.info("Queue client started — polling %s every %ds", self.base_url, self.poll_interval)
        busy_logged = False
        while True:
            try:
                if gpu_lock is not None and gpu_lock.locked():
                    if not busy_logged:
                        logger.info("GPU busy — pausing queue claims")
                        busy_logged = True
                    await asyncio.sleep(self.poll_interval)
                    continue
                if busy_logged:
                    logger.info("GPU free — resuming queue claims")
                    busy_logged = False

                claimed = await self._claim_job()
                if claimed:
                    job_id = claimed["id"]
                    config = claimed["config"]
                    logger.info("Claimed job %s from queue", job_id)
                    await self._process_remote_job(job_id, config, process_job_fn)
                else:
                    await asyncio.sleep(self.poll_interval)
            except Exception:
                logger.exception("Queue poll error")
                await asyncio.sleep(self.poll_interval)

    async def _claim_job(self) -> dict | None:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self.base_url}/api/v1/worker/claim", headers=self.headers, timeout=10
            )
            resp.raise_for_status()
            return resp.json().get("job")

    async def _process_remote_job(self, job_id: str, config: dict, process_job_fn):
        job_dir = settings.jobs_dir / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        try:
            await self._update_status(job_id, "processing")
            video_path = await self._download_video(job_id, job_dir)

            job_config = JobConfig(
                output_format=OutputFormat(config.get("output_format") or "splat"),
                max_frames=config.get("max_frames") or settings.default_max_frames,
                training_iterations=config.get("training_iterations")
                or settings.default_training_iterations,
                resolution=config.get("resolution") or settings.default_resolution,
            )

            stages = [
                {"name": "frame_extraction", "status": "pending"},
                {"name": "pose_estimation", "status": "pending"},
                {"name": "training", "status": "pending"},
                {"name": "cleanup", "status": "pending"},
                {"name": "conversion", "status": "pending"},
            ]

            async def report_stages():
                await self._update_status(job_id, "processing", stages=stages)

            result_path = await process_job_fn(
                job_id, video_path, job_dir, job_config, stages, report_stages
            )

            # Preview first: the result upload creates the feed post, which copies
            # the preview_key, so the preview must be registered beforehand.
            await self._upload_preview(job_id, job_dir)
            await self._upload_result(job_id, result_path)
            logger.info("Job %s completed and uploaded", job_id)
        except Exception as e:
            logger.exception("Remote job %s failed", job_id)
            await self._update_status(job_id, "failed", error=str(e))

    async def _download_video(self, job_id: str, job_dir: Path) -> Path:
        video_path = job_dir / "input.mp4"
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self.base_url}/api/v1/worker/jobs/{job_id}/video",
                headers=self.headers, timeout=120,
            )
            resp.raise_for_status()
            video_path.write_bytes(resp.content)
        logger.info("Downloaded video for job %s (%.1f MB)", job_id, video_path.stat().st_size / 1e6)
        return video_path

    async def _update_status(self, job_id, status, stages=None, error=None):
        body: dict = {"status": status}
        if stages is not None:
            body["stages"] = stages
        if error is not None:
            body["error"] = error
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.put(
                    f"{self.base_url}/api/v1/worker/jobs/{job_id}/status",
                    headers=self.headers, json=body, timeout=10,
                )
                resp.raise_for_status()
        except Exception:
            logger.warning("Failed to update status for job %s", job_id, exc_info=True)

    async def _upload_preview(self, job_id: str, job_dir: Path):
        for ext in ("webp", "png"):
            preview_path = job_dir / f"preview.{ext}"
            if not preview_path.exists():
                continue
            try:
                async with httpx.AsyncClient() as client:
                    resp = await client.put(
                        f"{self.base_url}/api/v1/worker/jobs/{job_id}/preview?format={ext}",
                        headers=self.headers, content=preview_path.read_bytes(), timeout=60,
                    )
                    resp.raise_for_status()
                logger.info("Uploaded %s preview for job %s", ext, job_id)
            except Exception:
                logger.warning("Failed to upload %s preview for job %s", ext, job_id, exc_info=True)

    async def _upload_result(self, job_id: str, result_path: Path):
        async with httpx.AsyncClient() as client:
            resp = await client.put(
                f"{self.base_url}/api/v1/worker/jobs/{job_id}/result",
                headers=self.headers, content=result_path.read_bytes(), timeout=120,
            )
            resp.raise_for_status()
