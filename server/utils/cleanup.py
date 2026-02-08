import asyncio
import logging
import shutil
import time
from pathlib import Path

from server.config import settings

logger = logging.getLogger(__name__)


def cleanup_job_dir(job_dir: Path, keep_result: bool = True):
    """Remove intermediate files from a job directory, optionally keeping the result."""
    if not job_dir.exists():
        return
    for item in job_dir.iterdir():
        if keep_result and item.suffix in (".splat", ".ply"):
            continue
        if item.is_dir():
            shutil.rmtree(item, ignore_errors=True)
        else:
            item.unlink(missing_ok=True)
    logger.info("Cleaned job dir: %s (keep_result=%s)", job_dir, keep_result)


def remove_job_dir(job_dir: Path):
    """Completely remove a job directory."""
    if job_dir.exists():
        shutil.rmtree(job_dir, ignore_errors=True)
        logger.info("Removed job dir: %s", job_dir)


async def periodic_cleanup(jobs: dict):
    """Background task to remove expired jobs."""
    ttl_seconds = settings.job_ttl_hours * 3600
    interval_seconds = settings.cleanup_interval_minutes * 60

    while True:
        await asyncio.sleep(interval_seconds)
        now = time.time()
        expired = []
        for job_id, job in jobs.items():
            created = job.get("created_at_ts", 0)
            if now - created > ttl_seconds:
                expired.append(job_id)

        for job_id in expired:
            job = jobs.pop(job_id, None)
            if job and "job_dir" in job:
                remove_job_dir(Path(job["job_dir"]))
            logger.info("Expired job removed: %s", job_id)

        if expired:
            logger.info("Periodic cleanup: removed %d expired jobs", len(expired))
