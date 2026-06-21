import logging
from pathlib import Path

import numpy as np
import torch

from server.config import settings
from server.utils.gpu import force_gpu_cleanup

logger = logging.getLogger(__name__)

# Module-level model cache to avoid reloading
_dust3r_model = None


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


def estimate_poses(
    frame_paths: list[Path],
    resolution: int = 512,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Estimate camera poses and dense point cloud using DUSt3R.

    Returns:
        poses:      (N, 4, 4) cam-to-world matrices
        intrinsics: (N, 3, 3) camera intrinsic matrices
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
        graph_mode = "swin-5"
    logger.info("Creating pairs with graph mode: %s (%d images)", graph_mode, n_images)
    pairs = make_pairs(images, scene_graph=graph_mode, prefilter=None, symmetrize=True)
    logger.info("Created %d image pairs", len(pairs))

    # Pairwise inference
    logger.info("Running pairwise inference...")
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

    # Normalize scene: center on point cloud centroid, scale so radius ≈ 5
    centroid = points.mean(axis=0)
    points_centered = points - centroid
    radius = np.percentile(np.linalg.norm(points_centered, axis=1), 95)
    target_radius = 5.0
    scale = target_radius / max(radius, 1e-6)

    points = points_centered * scale

    # Apply same transform to camera positions (translation column of c2w)
    poses[:, :3, 3] = (poses[:, :3, 3] - centroid) * scale

    logger.info(
        "DUSt3R results: %d poses, %d points (radius=%.3f, scale=%.3f)",
        len(poses),
        len(points),
        radius,
        scale,
    )

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
