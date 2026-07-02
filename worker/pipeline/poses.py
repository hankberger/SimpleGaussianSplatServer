import logging
from pathlib import Path

import numpy as np
import torch

from worker.config import settings
from worker.utils.gpu import force_gpu_cleanup

logger = logging.getLogger(__name__)

# Module-level model cache to avoid reloading
_dust3r_model = None


def estimate_poses(all_frames, sharp_frames, config):
    """Estimate camera poses + a point cloud for the frames (backend dispatcher).

    Tries COLMAP first (geometric SfM — sub-pixel accurate, CPU-bound, sidesteps
    DUSt3R's GPU-memory wall), falling back to DUSt3R (learned — robust on hard,
    low-texture, or few-frame captures) if COLMAP is disabled, errors, or
    registers too few frames.

    all_frames is the full evenly-spaced extraction (COLMAP runs on this so its
    sequential matcher sees even spacing); sharp_frames is the blur-filtered
    subset used for TRAINING. COLMAP registers all_frames then filters the result
    to sharp_frames. DUSt3R runs directly on sharp_frames (its memory limits it).

    Returns:
        poses:            (N, 4, 4) cam-to-world, scene-normalized
        intrinsics:       (N, 3, 3) at the training resolution (config.resolution)
        points:           (M, 3) point cloud, scene-normalized
        colors:           (M, 3) RGB in [0, 1]
        used_frame_paths: the sharp, registered frames aligned with poses
        backend:          "colmap" or "dust3r"
    """
    training_resolution = config.resolution

    if settings.colmap_enabled:
        try:
            from worker.pipeline.poses_colmap import estimate_poses_colmap

            # Register the FULL evenly-spaced set (sequential needs even spacing).
            poses, intrinsics, points, colors, used = estimate_poses_colmap(all_frames)
            n_registered = len(used)
            min_needed = max(
                settings.min_frames,
                int(len(all_frames) * settings.colmap_min_registered_frac),
            )
            if n_registered < min_needed:
                raise RuntimeError(
                    f"COLMAP registered only {n_registered}/{len(all_frames)} frames "
                    f"(< {min_needed} needed); falling back to DUSt3R"
                )
            # Keep the full sparse cloud (better init), but train only on the sharp
            # subset: filter the registered cameras to sharp frames by filename.
            sharp_names = {p.name for p in sharp_frames}
            keep = [i for i, p in enumerate(used) if p.name in sharp_names]
            if len(keep) < settings.min_frames:
                raise RuntimeError(
                    f"only {len(keep)} sharp frames registered (< {settings.min_frames})"
                )
            poses = poses[keep]
            intrinsics = intrinsics[keep]
            used = [used[i] for i in keep]
            points, poses = _normalize_scene(points, poses)
            logger.info(
                "Pose backend: COLMAP (%d/%d registered, %d sharp for training, %d points)",
                n_registered, len(all_frames), len(used), len(points),
            )
            return poses, intrinsics, points, colors, used, "colmap"
        except Exception:
            logger.warning(
                "COLMAP pose estimation failed; falling back to DUSt3R", exc_info=True
            )

    # DUSt3R runs on the sharp subset (sharper + fewer frames). Its global
    # alignment holds all views jointly on the GPU, so cap at dust3r_max_frames.
    dust3r_frames = sharp_frames
    if len(dust3r_frames) > settings.dust3r_max_frames:
        idx = np.unique(
            np.linspace(0, len(dust3r_frames) - 1, settings.dust3r_max_frames)
            .round()
            .astype(int)
        )
        dust3r_frames = [dust3r_frames[i] for i in idx]
        logger.info(
            "DUSt3R fallback: subsampled %d -> %d frames for GPU memory",
            len(frame_paths), len(dust3r_frames),
        )
    poses, intrinsics, points, colors = _estimate_poses_dust3r(
        dust3r_frames, settings.dust3r_resolution, training_resolution
    )
    points, poses = _normalize_scene(points, poses)
    logger.info(
        "Pose backend: DUSt3R (%d frames, %d points)", len(dust3r_frames), len(points)
    )
    return poses, intrinsics, points, colors, list(dust3r_frames), "dust3r"


def _normalize_scene(
    points: np.ndarray, poses: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Center the scene on its point-cloud centroid and scale so the 95th-pct
    radius ≈ 5. Applied identically to both backends so downstream scene-scale
    heuristics (densification, cleanup) behave the same regardless of pose source
    — both COLMAP and DUSt3R are only solved up-to-scale.
    """
    centroid = points.mean(axis=0)
    pc = points - centroid
    radius = float(np.percentile(np.linalg.norm(pc, axis=1), 95))
    scale = 5.0 / max(radius, 1e-6)
    points = pc * scale
    poses = poses.copy()
    poses[:, :3, 3] = (poses[:, :3, 3] - centroid) * scale
    return points, poses


def _load_model():
    """Load DUSt3R model, caching at module level."""
    global _dust3r_model
    if _dust3r_model is not None:
        return _dust3r_model

    from dust3r.model import AsymmetricCroCo3DStereo

    logger.info("Loading DUSt3R model: %s", settings.dust3r_model)
    _dust3r_model = AsymmetricCroCo3DStereo.from_pretrained(settings.dust3r_model)
    _dust3r_model = _dust3r_model.to(settings.gpu_device)
    _dust3r_model.eval()
    logger.info("DUSt3R model loaded")
    return _dust3r_model


def _estimate_poses_dust3r(
    frame_paths: list[Path],
    resolution: int,
    training_resolution: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Estimate camera poses and a dense point cloud using DUSt3R (fallback path).

    Returns (un-normalized; the dispatcher applies _normalize_scene):
        poses:      (N, 4, 4) cam-to-world matrices
        intrinsics: (N, 3, 3) camera intrinsics, rescaled to training_resolution
        points:     (M, 3)    3D point positions
        colors:     (M, 3)    point RGB colors [0, 1]
    """
    from dust3r.image_pairs import make_pairs
    from dust3r.inference import inference
    from dust3r.cloud_opt import global_aligner, GlobalAlignerMode
    from dust3r.utils.image import load_images

    device = settings.gpu_device
    model = _load_model()

    # Load images
    logger.info("Loading %d images at resolution %d", len(frame_paths), resolution)
    images = load_images([str(p) for p in frame_paths], size=resolution)

    # Create image pairs
    n_images = len(images)
    if n_images <= settings.dust3r_max_pairs_complete:
        graph_mode = "complete"
    else:
        graph_mode = f"swin-{settings.dust3r_swin_window}"
    logger.info("Creating pairs with graph mode: %s (%d images)", graph_mode, n_images)
    pairs = make_pairs(images, scene_graph=graph_mode, prefilter=None, symmetrize=True)
    logger.info("Created %d image pairs", len(pairs))

    # Pairwise inference — the ViT-Large forward is the bulk of pose time, so
    # run it under autocast (bf16/fp16). DUSt3R is inference-only here, and the
    # half-precision outputs feed the fp32 global alignment fine.
    logger.info("Running pairwise inference (amp=%s)...", settings.dust3r_amp_dtype if settings.dust3r_amp else "off")
    if settings.dust3r_amp:
        amp_dtype = torch.bfloat16 if settings.dust3r_amp_dtype == "bf16" else torch.float16
        with torch.autocast(device_type="cuda", dtype=amp_dtype):
            output = inference(pairs, model, device, batch_size=1)
    else:
        output = inference(pairs, model, device, batch_size=1)

    # Global alignment
    logger.info("Running global alignment (%d iterations)...", settings.dust3r_alignment_iters)
    mode = GlobalAlignerMode.PointCloudOptimizer if n_images > 2 else GlobalAlignerMode.PairViewer
    scene = global_aligner(output, device=device, mode=mode)

    if mode == GlobalAlignerMode.PointCloudOptimizer:
        loss = scene.compute_global_alignment(
            init="mst",
            niter=settings.dust3r_alignment_iters,
            schedule="cosine",
            lr=0.01,
        )
        logger.info("Global alignment final loss: %.4f", float(loss))

    # Extract results
    poses = _extract_poses(scene, n_images)
    intrinsics = _extract_intrinsics(scene, n_images)
    points, colors = _extract_point_cloud(scene, n_images)

    # Rescale intrinsics from DUSt3R's working resolution to the training
    # resolution (DUSt3R runs at its own fixed res; the trainer renders larger).
    if training_resolution != resolution:
        scale_k = training_resolution / resolution
        intrinsics = intrinsics.copy()
        intrinsics[:, 0, :] *= scale_k  # fx, skew, cx
        intrinsics[:, 1, :] *= scale_k  # fy, cy
        intrinsics[:, 2, :] = [0, 0, 1]

    logger.info("DUSt3R results: %d poses, %d points", len(poses), len(points))

    # Cleanup DUSt3R scene to free GPU memory
    del scene, output, pairs
    force_gpu_cleanup()

    return poses, intrinsics, points, colors


def _extract_poses(scene, n_images: int) -> np.ndarray:
    """Extract cam-to-world 4x4 pose matrices."""
    poses = scene.get_im_poses().detach().cpu().numpy()  # (N, 4, 4)
    assert poses.shape == (n_images, 4, 4), f"Expected {n_images} poses, got {poses.shape}"
    return poses


def _extract_intrinsics(scene, n_images: int) -> np.ndarray:
    """Extract 3x3 intrinsic matrices (focal + principal point)."""
    K = scene.get_intrinsics().detach().cpu().numpy()  # (N, 3, 3)
    assert K.shape == (n_images, 3, 3), f"Expected {n_images} intrinsics, got {K.shape}"
    return K.astype(np.float32)


def _extract_point_cloud(scene, n_images: int) -> tuple[np.ndarray, np.ndarray]:
    """Extract dense 3D point cloud with confidence filtering."""
    pts3d_list = scene.get_pts3d()  # list of (H, W, 3) tensors
    confidence_list = scene.get_masks()  # list of (H, W) bool tensors

    all_points = []
    all_colors = []

    imgs = scene.imgs  # list of (H, W, 3) numpy arrays

    for i in range(n_images):
        pts = pts3d_list[i].detach().cpu().numpy()  # (H, W, 3)
        conf_mask = confidence_list[i].detach().cpu().numpy()  # (H, W) bool
        img = imgs[i]  # (H, W, 3) float [0, 1]

        # Apply confidence mask
        pts_masked = pts[conf_mask]  # (K, 3)
        colors_masked = img[conf_mask]  # (K, 3)

        # Filter out points with extreme coordinates (outliers)
        valid = np.all(np.isfinite(pts_masked), axis=1)
        if valid.sum() > 0:
            pts_masked = pts_masked[valid]
            colors_masked = colors_masked[valid]

            # Remove statistical outliers (beyond 3 std from mean)
            mean = pts_masked.mean(axis=0)
            std = pts_masked.std(axis=0)
            inlier_mask = np.all(np.abs(pts_masked - mean) < 3 * std, axis=1)
            pts_masked = pts_masked[inlier_mask]
            colors_masked = colors_masked[inlier_mask]

        all_points.append(pts_masked)
        all_colors.append(colors_masked)

    points = np.concatenate(all_points, axis=0).astype(np.float32)
    colors = np.concatenate(all_colors, axis=0).astype(np.float32)

    # Subsample if too many points
    if len(points) > settings.dust3r_max_points:
        indices = np.random.choice(len(points), settings.dust3r_max_points, replace=False)
        points = points[indices]
        colors = colors[indices]
        logger.info("Subsampled point cloud to %d points", len(points))

    # Ensure colors are in [0, 1]
    colors = np.clip(colors, 0.0, 1.0)

    return points, colors
