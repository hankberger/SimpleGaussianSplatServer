"""Pose-estimation dispatcher.

Produces a single COLMAP-format dataset directory under ``<job_dir>/dataset``
that the LichtFeld training stage consumes, regardless of which backend ran:

  * COLMAP (primary)  — geometric SfM, sub-pixel accurate, CPU-bound.
  * DUSt3R (fallback) — learned, robust on hard/low-texture/few-frame captures.

Both write ``dataset/images/`` + ``dataset/sparse/0/{cameras,images,points3D}.bin``.
Scene normalization is intentionally NOT applied here — LichtFeld performs its
own scene scaling at load, and both backends are internally self-consistent.
"""

import logging
import shutil
import zipfile
from pathlib import Path

from splatworker.config import settings

logger = logging.getLogger(__name__)


def estimate_poses(frame_paths: list[Path], job_dir: Path, config) -> dict:
    """Run pose estimation and build the training dataset.

    Returns a dict::

        {
          "dataset_dir": Path,   # contains images/ + sparse/0/
          "backend": "colmap" | "dust3r",
          "registered": int, "total": int, "points": int,
        }
    """
    dataset_dir = job_dir / "dataset"
    if dataset_dir.exists():
        shutil.rmtree(dataset_dir, ignore_errors=True)
    dataset_dir.mkdir(parents=True, exist_ok=True)

    stats = None
    backend = None

    if settings.colmap_enabled:
        try:
            from splatworker.pipeline.colmap_backend import run_colmap

            stats = run_colmap(frame_paths, dataset_dir)
            min_needed = max(
                settings.min_frames,
                int(len(frame_paths) * settings.colmap_min_registered_frac),
            )
            if stats["registered"] < min_needed:
                raise RuntimeError(
                    f"COLMAP registered only {stats['registered']}/{len(frame_paths)} "
                    f"frames (< {min_needed} needed); falling back to DUSt3R"
                )
            backend = "colmap"
            logger.info("Pose backend: COLMAP (%d/%d registered, %d points)",
                        stats["registered"], stats["total"], stats["points"])
        except Exception:
            logger.warning("COLMAP pose estimation failed; falling back to DUSt3R", exc_info=True)
            backend = None

    if backend is None:
        # Reset the dataset dir — a partial COLMAP run may have left files.
        shutil.rmtree(dataset_dir, ignore_errors=True)
        dataset_dir.mkdir(parents=True, exist_ok=True)
        from splatworker.pipeline.dust3r_backend import run_dust3r

        stats = run_dust3r(frame_paths, dataset_dir, config.resolution)
        backend = "dust3r"
        logger.info("Pose backend: DUSt3R (%d frames, %d points)",
                    stats["registered"], stats["points"])

    if settings.save_dataset_zip:
        try:
            _save_dataset_zip(job_dir / "colmap_dataset.zip", dataset_dir)
        except Exception:
            logger.warning("Failed to save dataset zip (non-fatal)", exc_info=True)

    return {"dataset_dir": dataset_dir, "backend": backend, **stats}


def _save_dataset_zip(zip_path: Path, dataset_dir: Path) -> None:
    """Package the COLMAP dataset as a downloadable zip for debugging — reload
    OUR exact dataset into LichtFeld to bisect dataset quality vs training."""
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as zf:
        for p in dataset_dir.rglob("*"):
            if p.is_file():
                zf.write(p, p.relative_to(dataset_dir).as_posix())
    logger.info("Saved dataset zip: %s (%.1f MB)", zip_path, zip_path.stat().st_size / 1e6)
