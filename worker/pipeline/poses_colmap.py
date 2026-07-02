"""
COLMAP-based pose estimation (primary path; DUSt3R is the fallback).

COLMAP runs geometric Structure-from-Motion — SIFT features, matching, and
bundle adjustment that solves camera poses + sparse 3D points to sub-pixel
reprojection error. For a normal textured capture this is far more accurate than
DUSt3R's learned pointmaps (the difference between clean geometry and
ghosting/floaters), and it's CPU-bound, so it sidesteps DUSt3R's global-alignment
GPU-memory wall entirely.

Returns the same tuple shape the trainer consumes, for the REGISTERED subset of
frames (COLMAP may not register every frame — the dispatcher decides whether the
registered count is good enough or whether to fall back to DUSt3R). Intrinsics
are returned at the frame (training) resolution, so no rescale is needed.
"""

import logging
from pathlib import Path

import numpy as np

from worker.config import settings

logger = logging.getLogger(__name__)


def estimate_poses_colmap(
    frame_paths: list[Path],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, list[Path]]:
    """Run COLMAP SfM on the extracted frames.

    Returns:
        poses:            (N, 4, 4) cam-to-world matrices (COLMAP/OpenCV convention)
        intrinsics:       (N, 3, 3) pinhole K matching the UNDISTORTED images
        points:           (M, 3) sparse 3D points
        colors:           (M, 3) point RGB in [0, 1]
        used_frame_paths: the N UNDISTORTED image paths (train on these — lens
                          distortion has been removed), aligned with poses

    Raises on any failure (import error, no model, etc.) so the caller can fall
    back to DUSt3R. Poses/points are NOT scene-normalized here — the dispatcher
    applies the shared normalization to whichever backend ran.
    """
    import pycolmap

    image_dir = frame_paths[0].parent
    job_dir = image_dir.parent
    work = job_dir / "colmap"
    work.mkdir(parents=True, exist_ok=True)
    database_path = work / "database.db"
    sparse_dir = work / "sparse"
    sparse_dir.mkdir(parents=True, exist_ok=True)
    # Idempotent reruns: a stale DB makes extract_features error on duplicates.
    if database_path.exists():
        database_path.unlink()

    n = len(frame_paths)
    logger.info(
        "COLMAP: extracting SIFT features from %d frames (camera model %s)",
        n, settings.colmap_camera_model,
    )
    # SINGLE camera mode: all frames are from one phone camera, so share one
    # intrinsic. That gives bundle adjustment far more constraints than estimating
    # it per image (AUTO), for a more stable calibration. The camera MODEL (e.g.
    # OPENCV) sets which distortion params are fit + later undistorted away.
    reader_options = pycolmap.ImageReaderOptions()
    reader_options.camera_model = settings.colmap_camera_model
    pycolmap.extract_features(
        database_path,
        image_dir,
        camera_mode=pycolmap.CameraMode.SINGLE,
        reader_options=reader_options,
    )

    matcher = settings.colmap_matcher
    logger.info("COLMAP: %s matching", matcher)
    if matcher == "exhaustive":
        pycolmap.match_exhaustive(database_path)
    else:
        # Sequential is the right choice for a continuous video: it matches
        # consecutive frames (+ loop closure), far cheaper than all-pairs.
        pycolmap.match_sequential(database_path)

    logger.info("COLMAP: incremental mapping")
    reconstructions = pycolmap.incremental_mapping(database_path, image_dir, sparse_dir)
    if not reconstructions:
        raise RuntimeError("COLMAP produced no reconstruction")

    # Several disconnected sub-models can come back; keep the one that registered
    # the most images.
    best_id = max(reconstructions, key=lambda i: reconstructions[i].num_reg_images())
    best = reconstructions[best_id]
    logger.info(
        "COLMAP: best model registered %d/%d images, %d sparse points",
        best.num_reg_images(), n, len(best.points3D),
    )

    # Undistort. Phone lenses have real radial distortion, which COLMAP's default
    # SIMPLE_RADIAL camera model estimates. Our gsplat trainer is a PINHOLE
    # rasterizer, so the distortion MUST be removed from the images — otherwise
    # the Gaussians can't reconcile distorted pixels with a pinhole projection and
    # the geometry collapses to mush. (This is the step the classic COLMAP->3DGS
    # pipeline always runs; it's the same problem 3DGUT instead solves by modeling
    # distortion in the projection.) undistort_images writes undistorted images +
    # a PINHOLE reconstruction; we train on those, not the originals.
    rec_dir = sparse_dir / str(best_id)
    undist_dir = work / "undistorted"
    logger.info("COLMAP: undistorting %d images", best.num_reg_images())
    pycolmap.undistort_images(undist_dir, rec_dir, image_dir)
    rec = pycolmap.Reconstruction(undist_dir / "sparse")
    undist_images_dir = undist_dir / "images"

    poses: list[np.ndarray] = []
    Ks: list[np.ndarray] = []
    used: list[Path] = []
    for img in rec.images.values():
        path = undist_images_dir / img.name
        if not path.exists():
            continue  # undistorted image missing — skip defensively
        cam = rec.cameras[img.camera_id]
        # cam_from_world (world->cam) is a method in pycolmap 4.x, a property in
        # older versions — handle both. Invert for cam->world (what the trainer
        # wants). matrix() is 3x4 [R|t].
        cfw = img.cam_from_world
        if callable(cfw):
            cfw = cfw()
        w2c = np.eye(4, dtype=np.float64)
        w2c[:3, :4] = np.asarray(cfw.matrix(), dtype=np.float64)
        poses.append(np.linalg.inv(w2c).astype(np.float32))
        Ks.append(np.asarray(cam.calibration_matrix(), dtype=np.float32))
        used.append(path)

    if not used:
        raise RuntimeError("COLMAP reconstruction had no usable registered frames")

    # Save a downloadable dataset for debugging — load OUR exact COLMAP output
    # into another trainer (LichtFeld etc.) to bisect COLMAP vs training. Non-fatal.
    if settings.colmap_save_dataset:
        try:
            _save_dataset_zip(
                job_dir / "colmap_dataset.zip", undist_dir, image_dir, rec_dir
            )
        except Exception:
            logger.warning("Failed to save COLMAP dataset zip (non-fatal)", exc_info=True)

    # Sparse point cloud + colors (COLMAP stores RGB 0-255).
    pts = np.array([p.xyz for p in rec.points3D.values()], dtype=np.float32)
    cols = np.array([p.color for p in rec.points3D.values()], dtype=np.float32) / 255.0
    if pts.size == 0:
        raise RuntimeError("COLMAP reconstruction had no 3D points")

    # Cap the init cloud like the DUSt3R path (sparse is usually well under this).
    if len(pts) > settings.dust3r_max_points:
        idx = np.random.choice(len(pts), settings.dust3r_max_points, replace=False)
        pts, cols = pts[idx], cols[idx]

    poses_arr = np.stack(poses, axis=0)
    Ks_arr = np.stack(Ks, axis=0)
    return poses_arr, Ks_arr, pts, np.clip(cols, 0.0, 1.0), used


def _save_dataset_zip(
    zip_path: Path, undist_dir: Path, orig_images_dir: Path, raw_sparse_dir: Path
) -> None:
    """Package the COLMAP output as a downloadable zip for debugging.

    Layout (standard 3DGS — top level loads directly into COLMAP-based trainers):
        images/            undistorted images (what OUR trainer consumes)
        sparse/0/          undistorted PINHOLE model (cameras/images/points3D.bin)
        distorted/images/  the original extracted frames
        distorted/sparse/0/ the raw OPENCV-distortion model (run your own
                            undistortion / 3DGUT pipeline on this)

    Lets you bisect: load `images/`+`sparse/0/` into LichtFeld — if it looks good,
    our TRAINING is the problem; if it's bad, our COLMAP poses/undistortion are.
    """
    import zipfile

    undist_images = undist_dir / "images"
    undist_sparse = undist_dir / "sparse"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as zf:
        for p in undist_images.rglob("*"):
            if p.is_file():
                zf.write(p, f"images/{p.relative_to(undist_images).as_posix()}")
        for p in undist_sparse.rglob("*"):
            if p.is_file():
                zf.write(p, f"sparse/0/{p.relative_to(undist_sparse).as_posix()}")
        for p in sorted(orig_images_dir.glob("*")):
            if p.is_file():
                zf.write(p, f"distorted/images/{p.name}")
        for p in raw_sparse_dir.rglob("*"):
            if p.is_file():
                zf.write(p, f"distorted/sparse/0/{p.relative_to(raw_sparse_dir).as_posix()}")
    size_mb = zip_path.stat().st_size / 1e6
    logger.info("Saved COLMAP dataset: %s (%.1f MB)", zip_path, size_mb)
