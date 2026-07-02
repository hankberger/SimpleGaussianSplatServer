"""COLMAP Structure-from-Motion → a standard COLMAP/3DGS dataset directory.

Runs geometric SfM (SIFT + matching + bundle adjustment), undistorts the
registered images to a PINHOLE model, and lays the result out as::

    <dataset_dir>/
        images/        undistorted images (what LichtFeld trains on)
        sparse/0/      cameras.bin / images.bin / points3D.bin (PINHOLE)

This is exactly what LichtFeld Studio's COLMAP loader expects, so the trainer
consumes COLMAP and DUSt3R output through the same code path. Raises on any
failure so the dispatcher can fall back to DUSt3R.
"""

import logging
import shutil
from pathlib import Path

from splatworker.config import settings

logger = logging.getLogger(__name__)


def run_colmap(frame_paths: list[Path], dataset_dir: Path) -> dict:
    """Run COLMAP on ``frame_paths`` and populate ``dataset_dir``.

    Returns a stats dict: ``{registered, total, points}``.
    """
    import pycolmap

    if not frame_paths:
        raise RuntimeError("COLMAP: no input frames")

    image_dir = frame_paths[0].parent
    work = dataset_dir.parent / "colmap"
    work.mkdir(parents=True, exist_ok=True)
    database_path = work / "database.db"
    sparse_dir = work / "sparse"
    sparse_dir.mkdir(parents=True, exist_ok=True)
    # Idempotent reruns: a stale DB makes extract_features error on duplicates.
    if database_path.exists():
        database_path.unlink()

    n = len(frame_paths)
    logger.info("COLMAP: extracting SIFT features from %d frames (model %s, gpu=%s)",
                n, settings.colmap_camera_model, settings.colmap_use_gpu)

    # SINGLE camera mode: every frame is from one phone lens, so they share one
    # intrinsic — far more constraints for bundle adjustment than per-image (AUTO).
    reader_options = pycolmap.ImageReaderOptions()
    reader_options.camera_model = settings.colmap_camera_model
    _extract_features(pycolmap, database_path, image_dir, reader_options)

    matcher = settings.colmap_matcher
    logger.info("COLMAP: %s matching", matcher)
    _match(pycolmap, database_path, matcher)

    logger.info("COLMAP: incremental mapping")
    reconstructions = pycolmap.incremental_mapping(database_path, image_dir, sparse_dir)
    if not reconstructions:
        raise RuntimeError("COLMAP produced no reconstruction")

    # Several disconnected sub-models can come back; keep the largest.
    best_id = max(reconstructions, key=lambda i: reconstructions[i].num_reg_images())
    best = reconstructions[best_id]
    n_reg = best.num_reg_images()
    logger.info("COLMAP: best model registered %d/%d images, %d sparse points",
                n_reg, n, len(best.points3D))

    # Undistort to PINHOLE. Phone lenses have real radial distortion; a pinhole
    # splat renderer can't reconcile distorted pixels, so the distortion MUST be
    # removed from the images. undistort_images writes undistorted images + a
    # PINHOLE reconstruction — train on those.
    rec_dir = sparse_dir / str(best_id)
    undist_dir = work / "undistorted"
    logger.info("COLMAP: undistorting %d images", n_reg)
    pycolmap.undistort_images(undist_dir, rec_dir, image_dir)

    # Lay out the standard dataset: images/ + sparse/0/.
    _assemble_dataset(undist_dir, dataset_dir)

    rec = pycolmap.Reconstruction(dataset_dir / "sparse" / "0")
    n_points = len(rec.points3D)
    if n_points == 0:
        raise RuntimeError("COLMAP reconstruction had no 3D points")

    return {"registered": n_reg, "total": n, "points": n_points}


def _extract_features(pycolmap, database_path, image_dir, reader_options):
    """extract_features with GPU SIFT when requested, gracefully degrading if the
    installed pycolmap doesn't accept sift_options or lacks GPU support."""
    kwargs = dict(
        database_path=database_path,
        image_path=image_dir,
        camera_mode=pycolmap.CameraMode.SINGLE,
        reader_options=reader_options,
    )
    if settings.colmap_use_gpu:
        try:
            sift = pycolmap.SiftExtractionOptions()
            sift.use_gpu = True
            pycolmap.extract_features(sift_options=sift, **kwargs)
            return
        except Exception:
            logger.warning("COLMAP GPU SIFT extraction unavailable; using CPU", exc_info=True)
    pycolmap.extract_features(**kwargs)


def _match(pycolmap, database_path, matcher):
    if matcher == "sequential":
        # Continuous video: match consecutive frames (+ loop closure).
        pycolmap.match_sequential(database_path)
    else:
        pycolmap.match_exhaustive(database_path)


def _assemble_dataset(undist_dir: Path, dataset_dir: Path) -> None:
    """Move undistort output into the standard images/ + sparse/0/ layout."""
    images_src = undist_dir / "images"
    sparse_src = undist_dir / "sparse"
    if not images_src.exists() or not sparse_src.exists():
        raise RuntimeError(f"COLMAP undistort output incomplete in {undist_dir}")

    images_dst = dataset_dir / "images"
    sparse_dst = dataset_dir / "sparse" / "0"
    if images_dst.exists():
        shutil.rmtree(images_dst, ignore_errors=True)
    if sparse_dst.exists():
        shutil.rmtree(sparse_dst, ignore_errors=True)
    sparse_dst.parent.mkdir(parents=True, exist_ok=True)

    shutil.move(str(images_src), str(images_dst))
    # undistort writes cameras/images/points3D.bin directly under sparse/.
    shutil.move(str(sparse_src), str(sparse_dst))
    logger.info("COLMAP dataset assembled at %s", dataset_dir)
