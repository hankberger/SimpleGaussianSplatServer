import logging
from pathlib import Path
from typing import Callable, Optional

import imageio.v3 as iio
import numpy as np
import torch
import torch.nn.functional as F
from torchmetrics.image import StructuralSimilarityIndexMeasure

from worker.config import settings
from worker.utils.gpu import force_gpu_cleanup, gpu_memory_guard

logger = logging.getLogger(__name__)

SH_C0 = 0.28209479177387814


def _compute_knn_scale(points: np.ndarray, k: int = 4) -> np.ndarray:
    """Compute initial Gaussian scale from k-nearest-neighbor distances."""
    from scipy.spatial import cKDTree

    tree = cKDTree(points)
    dists, _ = tree.query(points, k=k + 1)  # +1 because closest is self
    avg_dist = dists[:, 1:].mean(axis=1)  # skip self
    return np.log(np.maximum(avg_dist, 1e-7)).astype(np.float32)


def _se3_exp(tangent: torch.Tensor) -> torch.Tensor:
    """Map se(3) tangent vectors (N, 6) -> SE(3) transforms (N, 4, 4).

    Layout: [tx, ty, tz, wx, wy, wz] (translation, then rotation axis-angle).
    Uses torch.matrix_exp on the 4x4 generator, which is exact and
    differentiable, so camera-pose deltas can be learned by backprop.
    """
    n = tangent.shape[0]
    t = tangent[:, :3]
    w = tangent[:, 3:]
    gen = torch.zeros(n, 4, 4, device=tangent.device, dtype=tangent.dtype)
    gen[:, 0, 1] = -w[:, 2]
    gen[:, 0, 2] = w[:, 1]
    gen[:, 1, 0] = w[:, 2]
    gen[:, 1, 2] = -w[:, 0]
    gen[:, 2, 0] = -w[:, 1]
    gen[:, 2, 1] = w[:, 0]
    gen[:, :3, 3] = t
    return torch.matrix_exp(gen)


def _load_images_as_tensors(
    frame_paths: list[Path], device: str
) -> list[torch.Tensor]:
    """Load images as (C, H, W) float32 tensors on device."""
    tensors = []
    for p in frame_paths:
        img = iio.imread(str(p))  # (H, W, 3) uint8
        t = torch.from_numpy(img).float() / 255.0  # (H, W, 3)
        t = t.permute(2, 0, 1)  # (C, H, W)
        tensors.append(t.to(device))
    return tensors


def train_gaussians(
    points: np.ndarray,
    colors: np.ndarray,
    poses: np.ndarray,
    intrinsics: np.ndarray,
    frame_paths: list[Path],
    max_steps: int = 3000,
    progress_cb: Optional[Callable[[int, float], None]] = None,
) -> Path:
    """
    Train 3D Gaussians from point cloud + posed images using gsplat.

    Args:
        points:      (M, 3) initial point positions
        colors:      (M, 3) point colors [0, 1]
        poses:       (N, 4, 4) cam-to-world matrices
        intrinsics:  (N, 3, 3) camera intrinsic matrices
        frame_paths: paths to training images
        max_steps:   number of training iterations
        progress_cb: callback(step, loss) called every 50 steps

    Returns:
        Path to exported PLY file
    """
    from gsplat import rasterization

    device = settings.gpu_device
    n_images = len(frame_paths)
    n_points = len(points)
    logger.info("Training gaussians: %d points, %d images, %d steps", n_points, n_images, max_steps)

    with gpu_memory_guard():
        # Load training images
        images = _load_images_as_tensors(frame_paths, device)
        img_h, img_w = images[0].shape[1], images[0].shape[2]

        # Precompute camera data
        # Convert cam-to-world to world-to-cam (viewmats)
        c2w = torch.from_numpy(poses).float().to(device)  # (N, 4, 4)
        w2c = torch.linalg.inv(c2w)  # (N, 4, 4)

        # Build proper intrinsics with principal point at image center
        Ks = torch.from_numpy(intrinsics).float().to(device)  # (N, 3, 3)
        for i in range(n_images):
            if Ks[i, 0, 2] == 0:
                Ks[i, 0, 2] = img_w / 2.0
            if Ks[i, 1, 2] == 0:
                Ks[i, 1, 2] = img_h / 2.0
            # If fy is 0 (from DUSt3R), copy fx
            if Ks[i, 1, 1] == 0:
                Ks[i, 1, 1] = Ks[i, 0, 0]

        # Initialize Gaussian parameters as a ParameterDict so gsplat's
        # DefaultStrategy can manage densification/pruning and migrate the
        # matching optimizer state. Representation: means (xyz), scales (log),
        # quats (raw, normalized in the rasterizer), opacities (logit), sh.
        means_init = torch.from_numpy(points).float().to(device)

        # Scales from KNN distances (log space)
        log_scales_np = _compute_knn_scale(points, k=settings.knn_k)
        scales_init = (
            torch.from_numpy(np.stack([log_scales_np] * 3, axis=-1)).float().to(device)
        )

        # Quaternions: identity rotation
        quats_init = torch.zeros(n_points, 4, device=device)
        quats_init[:, 0] = 1.0

        # Opacities: logit(0.1)
        opacities_init = torch.full((n_points,), np.log(0.1 / 0.9), device=device)

        # Spherical harmonics: degree 0 from point colors, higher degrees zero
        # (progressively activated during training)
        sh_degree_max = settings.sh_degree
        n_sh_bases = (sh_degree_max + 1) ** 2  # 16 for degree 3
        sh_init = torch.zeros(n_points, n_sh_bases, 3, device=device)
        sh_init[:, 0, :] = torch.from_numpy((colors - 0.5) / SH_C0).float()

        params = torch.nn.ParameterDict(
            {
                "means": torch.nn.Parameter(means_init),
                "scales": torch.nn.Parameter(scales_init),
                "quats": torch.nn.Parameter(quats_init),
                "opacities": torch.nn.Parameter(opacities_init),
                "sh": torch.nn.Parameter(sh_init),
            }
        ).to(device)

        # One Adam per parameter — gsplat strategies require each optimizer to
        # hold a single param group so they can grow/prune its state in lockstep.
        lrs = {
            "means": settings.lr_means,
            "scales": settings.lr_scales,
            "quats": settings.lr_quats,
            "opacities": settings.lr_opacities,
            "sh": settings.lr_sh,
        }
        optimizers = {
            name: torch.optim.Adam(
                [{"params": params[name], "lr": lr, "name": name}], eps=1e-15
            )
            for name, lr in lrs.items()
        }

        ssim_fn = StructuralSimilarityIndexMeasure(data_range=1.0).to(device)

        # Scale the densification (refine) window with training length.
        densify_end = max(settings.densify_end, int(max_steps * 0.7))
        scene_scale = float(np.linalg.norm(points.max(axis=0) - points.min(axis=0)))

        # gsplat DefaultStrategy: classic 3DGS grow (clone/split) + prune +
        # opacity reset, with correct optimizer-state migration. Replaces the
        # previous hand-rolled densification, which rebuilt Adam on every refine
        # step and thereby discarded all moment estimates. Existing tunables map
        # onto the strategy's knobs so behaviour stays controllable via config.
        from gsplat.strategy import DefaultStrategy

        strategy = DefaultStrategy(
            prune_opa=0.005,
            grow_grad2d=settings.densify_grad_thresh,
            grow_scale3d=0.01,
            prune_scale3d=0.1,
            refine_start_iter=settings.densify_start,
            refine_stop_iter=densify_end,
            reset_every=settings.opacity_reset_interval,
            refine_every=settings.densify_interval,
            verbose=True,
        )
        strategy_state = strategy.initialize_state(scene_scale=scene_scale)
        strategy.check_sanity(params, optimizers)

        # LR schedule for means: exponential decay from lr_means to lr_means_final
        lr_means_init = settings.lr_means
        lr_means_final = settings.lr_means_final
        if lr_means_final > 0 and lr_means_init > lr_means_final:
            lr_decay_rate = (lr_means_final / lr_means_init) ** (1.0 / max_steps)
        else:
            lr_decay_rate = 1.0

        # Progressive SH activation schedule (step thresholds for each degree)
        sh_activation_steps = [0, 1000, 2000, 3000]

        logger.info("Densification will run until step %d (%.0f%% of %d)", densify_end, densify_end / max_steps * 100, max_steps)

        # Camera pose optimization: a learnable se(3) correction per camera,
        # applied to the world-to-cam matrices. DUSt3R poses are approximate, so
        # refining them jointly with the Gaussians is a large quality lever.
        # Deltas start at zero (identity); they only move once stepped, after a
        # warm-up that lets the Gaussians settle first.
        pose_deltas = torch.nn.Parameter(torch.zeros(n_images, 6, device=device))
        pose_opt = torch.optim.Adam([pose_deltas], lr=settings.pose_opt_lr, weight_decay=1e-6)
        if settings.pose_opt_enabled:
            logger.info(
                "Camera pose optimization enabled (lr=%.1e, start=%d)",
                settings.pose_opt_lr, settings.pose_opt_start,
            )

        # PPISP photometric post-processing (optional)
        try:
            from ppisp import PPISP
            ppisp_module = PPISP(num_cameras=1, num_frames=n_images).to(device)
            ppisp_optimizers = ppisp_module.create_optimizers()
            ppisp_schedulers = ppisp_module.create_schedulers(ppisp_optimizers, max_steps)
            # Precompute pixel coordinate grid
            ys, xs = torch.meshgrid(
                torch.arange(img_h, device=device),
                torch.arange(img_w, device=device),
                indexing="ij",
            )
            pixel_coords = torch.stack([xs, ys], dim=-1).float()  # (H, W, 2)
            use_ppisp = True
            logger.info("PPISP enabled: photometric correction active")
        except ImportError:
            use_ppisp = False
            ppisp_module = None
            ppisp_optimizers = []
            ppisp_schedulers = []
            logger.info("PPISP not installed, skipping photometric correction")

        # Training loop
        for step in range(max_steps):
            # Update means LR with exponential decay
            if lr_decay_rate < 1.0:
                optimizers["means"].param_groups[0]["lr"] = lr_means_init * (
                    lr_decay_rate ** step
                )

            pose_active = settings.pose_opt_enabled and step >= settings.pose_opt_start

            for opt in optimizers.values():
                opt.zero_grad(set_to_none=True)
            if use_ppisp:
                for opt in ppisp_optimizers:
                    opt.zero_grad(set_to_none=True)
            if pose_active:
                pose_opt.zero_grad(set_to_none=True)

            # Cycle through images
            img_idx = step % n_images
            gt_image = images[img_idx]  # (C, H, W)

            # Progressive SH degree: activate higher bands as training progresses
            active_sh_degree = 0
            for d in range(1, sh_degree_max + 1):
                if d < len(sh_activation_steps) and step >= sh_activation_steps[d]:
                    active_sh_degree = d

            # Rasterize with SH coefficients — gsplat computes view-dependent color.
            # quats are passed raw; the rasterizer normalizes them internally.
            # When pose optimization is active, apply the learned SE(3) delta to
            # this camera's world-to-cam matrix (differentiable w.r.t. the delta).
            if pose_active:
                delta = _se3_exp(pose_deltas[img_idx : img_idx + 1])  # (1, 4, 4)
                viewmat = delta @ w2c[img_idx : img_idx + 1]  # (1, 4, 4)
            else:
                viewmat = w2c[img_idx : img_idx + 1]  # (1, 4, 4)
            K = Ks[img_idx : img_idx + 1]  # (1, 3, 3)

            renders, alphas, info = rasterization(
                means=params["means"],
                quats=params["quats"],
                scales=torch.exp(params["scales"]),
                opacities=torch.sigmoid(params["opacities"]),
                colors=params["sh"],
                viewmats=viewmat,
                Ks=K,
                width=img_w,
                height=img_h,
                packed=False,
                sh_degree=active_sh_degree,
                rasterize_mode=settings.rasterize_mode,
            )

            # Strategy bookkeeping: retain/track 2D-means gradients for this step.
            strategy.step_pre_backward(params, optimizers, strategy_state, step, info)

            # renders: (1, H, W, C) -> (C, H, W)
            rendered = renders[0]  # (H, W, 3)
            if use_ppisp:
                rendered = ppisp_module(
                    rendered,
                    pixel_coords,
                    resolution=(img_w, img_h),
                    camera_idx=0,
                    frame_idx=img_idx,
                )
            rendered = rendered.permute(2, 0, 1)  # (C, H, W)

            # L1 every step; SSIM (more expensive) only every ssim_every steps.
            # Loss math optionally under autocast (rasterizer stays fp32).
            with torch.autocast(device_type="cuda", enabled=settings.use_amp):
                l1_loss = F.l1_loss(rendered, gt_image)
                if settings.ssim_every <= 1 or step % settings.ssim_every == 0:
                    ssim_loss = 1.0 - ssim_fn(
                        rendered.unsqueeze(0), gt_image.unsqueeze(0)
                    )
                    loss = (
                        (1.0 - settings.ssim_weight) * l1_loss
                        + settings.ssim_weight * ssim_loss
                    )
                else:
                    loss = l1_loss
                if use_ppisp:
                    loss = loss + settings.ppisp_reg_weight * ppisp_module.get_regularization_loss()
            loss = loss.float()

            loss.backward()

            for opt in optimizers.values():
                opt.step()
            if use_ppisp:
                for opt in ppisp_optimizers:
                    opt.step()
                for sched in ppisp_schedulers:
                    sched.step()
            if pose_active:
                pose_opt.step()

            # Densify (clone/split) + prune + opacity reset, with optimizer state
            # migrated to match. The strategy gates this to its refine window.
            strategy.step_post_backward(
                params, optimizers, strategy_state, step, info, packed=False
            )

            # Log SH degree activation
            if active_sh_degree > 0 and step in sh_activation_steps:
                logger.info("Activated SH degree %d at step %d", active_sh_degree, step)

            # Progress reporting
            if step % 50 == 0:
                loss_val = loss.item()
                logger.info(
                    "Step %d/%d, loss=%.4f, n_gaussians=%d, sh_degree=%d",
                    step, max_steps, loss_val, len(params["means"]), active_sh_degree,
                )
                if progress_cb:
                    progress_cb(step, loss_val)

        # Export
        output_dir = frame_paths[0].parent.parent
        ply_path = output_dir / "output.ply"
        export_ply(
            ply_path,
            params["means"].detach().cpu().numpy(),
            params["scales"].detach().cpu().numpy(),
            params["quats"].detach().cpu().numpy(),
            params["opacities"].detach().cpu().numpy(),
            params["sh"].detach().cpu().numpy(),
        )
        logger.info("Exported PLY: %s (%d gaussians)", ply_path, len(params["means"]))

        # Render a representative preview (PNG + WebP) for client thumbnails.
        # Non-fatal: a preview failure must not fail an otherwise-successful job.
        try:
            preview_idx = n_images // 2
            # Use the optimized pose for this camera if pose-opt ran.
            if settings.pose_opt_enabled:
                preview_view = (
                    _se3_exp(pose_deltas[preview_idx : preview_idx + 1])
                    @ w2c[preview_idx : preview_idx + 1]
                ).detach()
            else:
                preview_view = w2c[preview_idx : preview_idx + 1]
            _save_preview(
                rasterization,
                params["means"].detach(),
                params["quats"].detach(),
                torch.exp(params["scales"].detach()),
                torch.sigmoid(params["opacities"].detach()),
                params["sh"].detach(),
                preview_view,
                Ks[preview_idx : preview_idx + 1],
                img_w,
                img_h,
                sh_degree_max,
                output_dir,
            )
        except Exception:
            logger.warning("Preview render failed (non-fatal)", exc_info=True)

        return ply_path


def _save_preview(
    rasterization,
    means: torch.Tensor,
    quats: torch.Tensor,
    scales: torch.Tensor,
    opacities: torch.Tensor,
    sh_coeffs: torch.Tensor,
    viewmat: torch.Tensor,
    K: torch.Tensor,
    img_w: int,
    img_h: int,
    sh_degree: int,
    output_dir: Path,
) -> tuple[Path, Path]:
    """Render one representative view of the trained scene and save it as a
    lossless PNG and a compact WebP, so clients can preview a scene without
    downloading the full splat. Uses OpenCV (already a dependency) for encoding.
    """
    import cv2

    with torch.no_grad():
        renders, _, _ = rasterization(
            means=means,
            quats=quats / (quats.norm(dim=-1, keepdim=True) + 1e-8),
            scales=scales,
            opacities=opacities,
            colors=sh_coeffs,
            viewmats=viewmat,
            Ks=K,
            width=img_w,
            height=img_h,
            packed=False,
            sh_degree=sh_degree,
            rasterize_mode=settings.rasterize_mode,
        )

    # (1, H, W, 3) RGB float -> (H, W, 3) uint8
    img = renders[0].clamp(0.0, 1.0).cpu().numpy()
    img = (img * 255.0 + 0.5).astype(np.uint8)

    # Downscale so the longest side fits preview_max_dim (keeps previews small)
    max_dim = settings.preview_max_dim
    h, w = img.shape[:2]
    if max(h, w) > max_dim:
        s = max_dim / max(h, w)
        img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)

    bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    png_path = output_dir / "preview.png"
    webp_path = output_dir / "preview.webp"
    cv2.imwrite(str(png_path), bgr)
    cv2.imwrite(
        str(webp_path), bgr, [cv2.IMWRITE_WEBP_QUALITY, settings.preview_webp_quality]
    )
    logger.info("Saved preview: %s, %s", png_path, webp_path)
    return png_path, webp_path


def export_ply(
    path: Path,
    means: np.ndarray,
    log_scales: np.ndarray,
    quats: np.ndarray,
    logit_opacities: np.ndarray,
    sh_coeffs: np.ndarray,
):
    """Write standard 3DGS-compatible PLY binary file with full SH coefficients.

    Args:
        sh_coeffs: (N, K, 3) array where K = (sh_degree+1)^2. The first
                   entry (index 0) is the DC component, the rest are higher-order.
    """
    n = len(means)
    n_sh_bases = sh_coeffs.shape[1]  # e.g. 16 for degree 3
    n_rest = n_sh_bases - 1  # number of higher-order bases (15 for degree 3)
    path.parent.mkdir(parents=True, exist_ok=True)

    # PLY header — DC coefficients + rest coefficients
    header_lines = [
        "ply",
        "format binary_little_endian 1.0",
        f"element vertex {n}",
        "property float x",
        "property float y",
        "property float z",
        "property float f_dc_0",
        "property float f_dc_1",
        "property float f_dc_2",
    ]
    # Higher-order SH coefficients (f_rest_0 through f_rest_{3*n_rest-1})
    for i in range(n_rest * 3):
        header_lines.append(f"property float f_rest_{i}")
    header_lines += [
        "property float opacity",
        "property float scale_0",
        "property float scale_1",
        "property float scale_2",
        "property float rot_0",
        "property float rot_1",
        "property float rot_2",
        "property float rot_3",
        "end_header\n",
    ]
    header = "\n".join(header_lines)

    # Build data array: x,y,z (3) + f_dc (3) + f_rest (n_rest*3) + opacity (1) + scale (3) + rot (4)
    n_floats = 3 + 3 + n_rest * 3 + 1 + 3 + 4
    data = np.empty((n, n_floats), dtype=np.float32)

    col = 0
    # Position
    data[:, col:col+3] = means.astype(np.float32)
    col += 3
    # DC coefficients: sh_coeffs[:, 0, :] -> (N, 3)
    data[:, col:col+3] = sh_coeffs[:, 0, :].astype(np.float32)
    col += 3
    # Higher-order SH: sh_coeffs[:, 1:, :] -> (N, n_rest, 3) -> flatten to (N, n_rest*3)
    # Standard 3DGS PLY ordering: interleave as [sh1_r, sh1_g, sh1_b, sh2_r, ...]
    if n_rest > 0:
        rest = sh_coeffs[:, 1:, :].reshape(n, n_rest * 3).astype(np.float32)
        data[:, col:col+n_rest*3] = rest
        col += n_rest * 3
    # Opacity
    data[:, col] = logit_opacities.astype(np.float32)
    col += 1
    # Scales
    data[:, col:col+3] = log_scales.astype(np.float32)
    col += 3
    # Rotations
    data[:, col:col+4] = quats.astype(np.float32)

    with open(path, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(data.tobytes())
