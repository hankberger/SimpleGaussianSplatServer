"""
Queue client that polls the Cloudflare Worker for jobs to process.

When SPLAT_QUEUE_URL is configured, this module polls the render-queue Worker
for queued jobs, downloads videos, runs the existing pipeline, reports progress,
and uploads results — all without modifying the core pipeline code.
"""

import asyncio
import logging
from pathlib import Path

import httpx

from server.config import settings
from server.models import JobConfig, OutputFormat

logger = logging.getLogger(__name__)


class QueueClient:
    def __init__(self):
        self.base_url = settings.queue_url.rstrip("/")
        self.headers = {"Authorization": f"Bearer {settings.queue_api_key}"}
        self.poll_interval = settings.queue_poll_interval

    async def run(self, process_job_fn):
        """Main polling loop. Runs forever as a background task."""
        logger.info(
            "Queue client started — polling %s every %ds",
            self.base_url,
            self.poll_interval,
        )

        while True:
            try:
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
        """Try to claim the oldest queued job."""
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self.base_url}/api/v1/worker/claim",
                headers=self.headers,
                timeout=10,
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("job")

    async def _process_remote_job(self, job_id: str, config: dict, process_job_fn):
        """Download video, run pipeline, upload result."""
        job_dir = settings.jobs_dir / job_id
        job_dir.mkdir(parents=True, exist_ok=True)

        try:
            # Report processing status
            await self._update_status(job_id, "processing")

            # Download video from Worker
            video_path = await self._download_video(job_id, job_dir)

            # Build a JobConfig from the remote config
            job_config = JobConfig(
                output_format=OutputFormat(config.get("output_format", "splat")),
                max_frames=config.get("max_frames", 40),
                training_iterations=config.get("training_iterations", 7000),
                resolution=config.get("resolution", 768),
            )

            # Build stage-progress reporter
            stages = [
                {"name": "frame_extraction", "status": "pending"},
                {"name": "pose_estimation", "status": "pending"},
                {"name": "training", "status": "pending"},
                {"name": "conversion", "status": "pending"},
            ]

            async def report_stages():
                await self._update_status(job_id, "processing", stages=stages)

            # Run the pipeline using the existing process_job infrastructure
            result_path = await process_job_fn(
                job_id, video_path, job_dir, job_config, stages, report_stages
            )

            # Upload result
            await self._upload_result(job_id, result_path)
            logger.info("Job %s completed and uploaded", job_id)

        except Exception as e:
            logger.exception("Remote job %s failed", job_id)
            await self._update_status(job_id, "failed", error=str(e))

    async def _download_video(self, job_id: str, job_dir: Path) -> Path:
        """Download video from the Worker's R2 storage."""
        video_path = job_dir / "input.mp4"
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self.base_url}/api/v1/worker/jobs/{job_id}/video",
                headers=self.headers,
                timeout=120,
            )
            resp.raise_for_status()
            with open(video_path, "wb") as f:
                f.write(resp.content)

        logger.info("Downloaded video for job %s (%.1f MB)", job_id, video_path.stat().st_size / 1e6)
        return video_path

    async def _update_status(
        self, job_id: str, status: str, stages: list | None = None, error: str | None = None
    ):
        """Report status/progress back to the Worker."""
        body: dict = {"status": status}
        if stages is not None:
            body["stages"] = stages
        if error is not None:
            body["error"] = error

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.put(
                    f"{self.base_url}/api/v1/worker/jobs/{job_id}/status",
                    headers=self.headers,
                    json=body,
                    timeout=10,
                )
                resp.raise_for_status()
        except Exception:
            logger.warning("Failed to update status for job %s", job_id, exc_info=True)

    async def _upload_result(self, job_id: str, result_path: Path):
        """Upload the .splat/.ply result to the Worker's R2 storage."""
        async with httpx.AsyncClient() as client:
            with open(result_path, "rb") as f:
                resp = await client.put(
                    f"{self.base_url}/api/v1/worker/jobs/{job_id}/result",
                    headers=self.headers,
                    content=f.read(),
                    timeout=120,
                )
                resp.raise_for_status()
