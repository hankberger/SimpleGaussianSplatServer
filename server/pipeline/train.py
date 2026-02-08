import logging
from pathlib import Path
from typing import Callable, Optional

import imageio.v3 as iio
import numpy as np
import torch
import torch.nn.functional as F
from torchmetrics.image import StructuralSimilarityIndexMeasure

from server.config import settings
from server.utils.gpu import force_gpu_cleanup, gpu_memory_guard

logger = logging.getLogger(__name__)

SH_C0 = 0.28209479177387814


def _compute_knn_scale(points: np.ndarray, k: int = 4) -> np.ndarray:
    """Compute initial Gaussian scale from k-nearest-neighbor distances."""
    from scipy.spatial import cKDTree

    tree = cKDTree(points)
    dists, _ = tree.query(points, k=k + 1)  # +1 because closest is self
    avg_dist = dists[:, 1:].mean(axis=1)  # skip self
    return np.log(np.maximum(avg_dist, 1e-7)).astype(np.float32)


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

        # Initialize Gaussian parameters
        means = torch.from_numpy(points).float().to(device).requires_grad_(True)

        # Scales from KNN distances
        log_scales_np = _compute_knn_scale(points, k=settings.knn_k)
        log_scales = (
            torch.from_numpy(np.stack([log_scales_np] * 3, axis=-1))
            .float()
            .to(device)
            .requires_grad_(True)
        )

        # Quaternions: identity rotation
        quats = torch.zeros(n_points, 4, device=device)
        quats[:, 0] = 1.0
        quats = quats.requires_grad_(True)

        # Opacities: logit(0.1)
        logit_opacities = (
            torch.full((n_points,), np.log(0.1 / 0.9), device=device)
            .requires_grad_(True)
        )

        # Spherical harmonics (degree 0 only): (color - 0.5) / SH_C0
        sh0 = (
            torch.from_numpy((colors - 0.5) / SH_C0)
            .float()
            .to(device)
            .requires_grad_(True)
        )

        # Optimizer
        optimizer = torch.optim.Adam(
            [
                {"params": [means], "lr": settings.lr_means, "name": "means"},
                {"params": [log_scales], "lr": settings.lr_scales, "name": "scales"},
                {"params": [quats], "lr": settings.lr_quats, "name": "quats"},
                {"params": [logit_opacities], "lr": settings.lr_opacities, "name": "opacities"},
                {"params": [sh0], "lr": settings.lr_sh, "name": "sh"},
            ],
        )

        ssim_fn = StructuralSimilarityIndexMeasure(data_range=1.0).to(device)

        # Gradient accumulator for densification
        grad_accum = torch.zeros(n_points, device=device)
        grad_count = torch.zeros(n_points, device=device, dtype=torch.int32)

        # Scale threshold for split vs clone: gaussians larger than this get split
        scene_extent = np.linalg.norm(points.max(axis=0) - points.min(axis=0))
        split_scale_thresh = scene_extent * 0.01

        # LR schedule for means: exponential decay from lr_means to lr_means_final
        lr_means_init = settings.lr_means
        lr_means_final = settings.lr_means_final
        if lr_means_final > 0 and lr_means_init > lr_means_final:
            lr_decay_rate = (lr_means_final / lr_means_init) ** (1.0 / max_steps)
        else:
            lr_decay_rate = 1.0

        # Training loop
        for step in range(max_steps):
            # Update means LR with exponential decay
            if lr_decay_rate < 1.0:
                new_lr = lr_means_init * (lr_decay_rate ** step)
                for pg in optimizer.param_groups:
                    if pg.get("name") == "means":
                        pg["lr"] = new_lr

            optimizer.zero_grad()

            # Cycle through images
            img_idx = step % n_images
            gt_image = images[img_idx]  # (C, H, W)

            # Current Gaussian parameters
            opacities = torch.sigmoid(logit_opacities)
            scales = torch.exp(log_scales)
            colors_sh = sh0 * SH_C0 + 0.5  # Convert SH0 back to RGB
            colors_rgb = torch.clamp(colors_sh, 0.0, 1.0)

            # Rasterize
            viewmat = w2c[img_idx : img_idx + 1]  # (1, 4, 4)
            K = Ks[img_idx : img_idx + 1]  # (1, 3, 3)

            renders, alphas, meta = rasterization(
                means=means,
                quats=quats / (quats.norm(dim=-1, keepdim=True) + 1e-8),
                scales=scales,
                opacities=opacities,
                colors=colors_rgb,
                viewmats=viewmat,
                Ks=K,
                width=img_w,
                height=img_h,
                packed=False,
                render_mode="RGB",
            )
            # renders: (1, H, W, C) -> (C, H, W)
            rendered = renders[0].permute(2, 0, 1)

            # L1 + SSIM loss
            l1_loss = F.l1_loss(rendered, gt_image)
            ssim_loss = 1.0 - ssim_fn(
                rendered.unsqueeze(0), gt_image.unsqueeze(0)
            )
            loss = (1.0 - settings.ssim_weight) * l1_loss + settings.ssim_weight * ssim_loss

            loss.backward()

            # Accumulate gradients for densification
            if means.grad is not None and settings.densify_start <= step < settings.densify_end:
                grad_norms = means.grad.detach().norm(dim=-1)
                visible = meta.get("gaussian_ids", None)
                if visible is not None and len(visible) > 0:
                    grad_accum[visible] += grad_norms[visible]
                    grad_count[visible] += 1
                else:
                    # Fallback: accumulate for all gaussians
                    grad_accum += grad_norms
                    grad_count += 1

            # Densification + pruning
            if (
                settings.densify_start <= step < settings.densify_end
                and step % settings.densify_interval == 0
                and step > settings.densify_start
            ):
                if len(means) < settings.densify_max_gaussians:
                    means, log_scales, quats, logit_opacities, sh0, optimizer, grad_accum, grad_count = (
                        _densify(
                            means,
                            log_scales,
                            quats,
                            logit_opacities,
                            sh0,
                            optimizer,
                            grad_accum,
                            grad_count,
                            settings.densify_grad_thresh,
                            settings.densify_max_gaussians,
                            split_scale_thresh,
                        )
                    )

                # Prune near-transparent gaussians
                alive = torch.sigmoid(logit_opacities) > 0.005
                if (~alive).sum() > 0 and alive.sum() > 100:
                    n_before = len(means)
                    means, log_scales, quats, logit_opacities, sh0, optimizer, grad_accum, grad_count = (
                        _prune(means, log_scales, quats, logit_opacities, sh0, alive, optimizer)
                    )
                    logger.info("Pruned %d transparent gaussians (%d -> %d)", n_before - len(means), n_before, len(means))

            optimizer.step()

            # Progress reporting
            if step % 50 == 0:
                loss_val = loss.item()
                logger.info("Step %d/%d, loss=%.4f, n_gaussians=%d", step, max_steps, loss_val, len(means))
                if progress_cb:
                    progress_cb(step, loss_val)

        # Export
        output_dir = frame_paths[0].parent.parent
        ply_path = output_dir / "output.ply"
        export_ply(
            ply_path,
            means.detach().cpu().numpy(),
            log_scales.detach().cpu().numpy(),
            quats.detach().cpu().numpy(),
            logit_opacities.detach().cpu().numpy(),
            sh0.detach().cpu().numpy(),
        )
        logger.info("Exported PLY: %s (%d gaussians)", ply_path, len(means))
        return ply_path


def _densify(
    means, log_scales, quats, logit_opacities, sh0,
    optimizer, grad_accum, grad_count, grad_thresh, max_gaussians,
    split_scale_thresh,
):
    """Split large / clone small Gaussians with high positional gradients."""
    device = means.device
    n = len(means)

    # Average gradient
    avg_grad = grad_accum / (grad_count.float() + 1e-8)

    # High-gradient mask
    high_grad = avg_grad > grad_thresh
    if high_grad.sum() == 0:
        grad_accum.zero_()
        grad_count.zero_()
        return means, log_scales, quats, logit_opacities, sh0, optimizer, grad_accum, grad_count

    # Separate into split (large) vs clone (small) based on scale
    max_scale = torch.exp(log_scales).max(dim=-1).values  # per-gaussian max scale
    split_mask = high_grad & (max_scale > split_scale_thresh)
    clone_mask = high_grad & ~split_mask

    n_split = split_mask.sum().item()
    n_clone = clone_mask.sum().item()

    # Check budget: splits produce 2 new (replace original later via smaller scale), clones produce 1 new
    n_new = n_split + n_clone
    if n_new == 0 or n + n_new > max_gaussians:
        grad_accum.zero_()
        grad_count.zero_()
        return means, log_scales, quats, logit_opacities, sh0, optimizer, grad_accum, grad_count

    logger.info("Densifying: split %d, clone %d gaussians (total: %d -> %d)", n_split, n_clone, n, n + n_new)

    new_parts = {
        "means": [],
        "log_scales": [],
        "quats": [],
        "logit_opacities": [],
        "sh0": [],
    }

    # Clone: duplicate small gaussians as-is
    if n_clone > 0:
        new_parts["means"].append(means[clone_mask].detach().clone())
        new_parts["log_scales"].append(log_scales[clone_mask].detach().clone())
        new_parts["quats"].append(quats[clone_mask].detach().clone())
        new_parts["logit_opacities"].append(logit_opacities[clone_mask].detach().clone())
        new_parts["sh0"].append(sh0[clone_mask].detach().clone())

    # Split: create 2 children offset from parent, shrink scale by 1.6x
    if n_split > 0:
        parent_means = means[split_mask].detach()
        parent_scales = log_scales[split_mask].detach()
        parent_quats = quats[split_mask].detach()
        parent_opacities = logit_opacities[split_mask].detach()
        parent_sh0 = sh0[split_mask].detach()

        # Sample offset along gaussian's extent
        stdev = torch.exp(parent_scales)  # (K, 3)
        offset = torch.randn_like(stdev) * stdev

        # Two children: parent ± offset, with reduced scale
        shrink = np.log(1.6)  # reduce scale by factor of 1.6
        for sign in [1.0, -1.0]:
            new_parts["means"].append(parent_means + sign * offset)
            new_parts["log_scales"].append(parent_scales - shrink)
            new_parts["quats"].append(parent_quats.clone())
            new_parts["logit_opacities"].append(parent_opacities.clone())
            new_parts["sh0"].append(parent_sh0.clone())

        # Remove split parents by masking them out
        keep_mask = ~split_mask
        means = means[keep_mask].detach()
        log_scales = log_scales[keep_mask].detach()
        quats = quats[keep_mask].detach()
        logit_opacities = logit_opacities[keep_mask].detach()
        sh0 = sh0[keep_mask].detach()

    # Concatenate all
    all_means = [means.detach()] + new_parts["means"]
    all_log_scales = [log_scales.detach()] + new_parts["log_scales"]
    all_quats = [quats.detach()] + new_parts["quats"]
    all_logit_opacities = [logit_opacities.detach()] + new_parts["logit_opacities"]
    all_sh0 = [sh0.detach()] + new_parts["sh0"]

    means = torch.cat(all_means).requires_grad_(True)
    log_scales = torch.cat(all_log_scales).requires_grad_(True)
    quats = torch.cat(all_quats).requires_grad_(True)
    logit_opacities = torch.cat(all_logit_opacities).requires_grad_(True)
    sh0 = torch.cat(all_sh0).requires_grad_(True)

    # Rebuild optimizer with new parameters
    optimizer = torch.optim.Adam(
        [
            {"params": [means], "lr": settings.lr_means, "name": "means"},
            {"params": [log_scales], "lr": settings.lr_scales, "name": "scales"},
            {"params": [quats], "lr": settings.lr_quats, "name": "quats"},
            {"params": [logit_opacities], "lr": settings.lr_opacities, "name": "opacities"},
            {"params": [sh0], "lr": settings.lr_sh, "name": "sh"},
        ],
    )

    # Reset accumulators
    new_n = len(means)
    grad_accum = torch.zeros(new_n, device=device)
    grad_count = torch.zeros(new_n, device=device, dtype=torch.int32)

    return means, log_scales, quats, logit_opacities, sh0, optimizer, grad_accum, grad_count


def _prune(means, log_scales, quats, logit_opacities, sh0, keep_mask, optimizer):
    """Remove gaussians where keep_mask is False."""
    device = means.device
    means = means[keep_mask].detach().requires_grad_(True)
    log_scales = log_scales[keep_mask].detach().requires_grad_(True)
    quats = quats[keep_mask].detach().requires_grad_(True)
    logit_opacities = logit_opacities[keep_mask].detach().requires_grad_(True)
    sh0 = sh0[keep_mask].detach().requires_grad_(True)

    optimizer = torch.optim.Adam(
        [
            {"params": [means], "lr": settings.lr_means, "name": "means"},
            {"params": [log_scales], "lr": settings.lr_scales, "name": "scales"},
            {"params": [quats], "lr": settings.lr_quats, "name": "quats"},
            {"params": [logit_opacities], "lr": settings.lr_opacities, "name": "opacities"},
            {"params": [sh0], "lr": settings.lr_sh, "name": "sh"},
        ],
    )

    new_n = len(means)
    grad_accum = torch.zeros(new_n, device=device)
    grad_count = torch.zeros(new_n, device=device, dtype=torch.int32)
    return means, log_scales, quats, logit_opacities, sh0, optimizer, grad_accum, grad_count


def export_ply(
    path: Path,
    means: np.ndarray,
    log_scales: np.ndarray,
    quats: np.ndarray,
    logit_opacities: np.ndarray,
    sh0: np.ndarray,
):
    """Write standard 3DGS-compatible PLY binary file (vectorized)."""
    n = len(means)
    path.parent.mkdir(parents=True, exist_ok=True)

    # PLY header
    header = f"""ply
format binary_little_endian 1.0
element vertex {n}
property float x
property float y
property float z
property float f_dc_0
property float f_dc_1
property float f_dc_2
property float opacity
property float scale_0
property float scale_1
property float scale_2
property float rot_0
property float rot_1
property float rot_2
property float rot_3
end_header
"""

    # Build a structured array for fast binary write
    # Property order: x,y,z, f_dc_0-2, opacity, scale_0-2, rot_0-3 = 14 floats
    data = np.empty((n, 14), dtype=np.float32)
    data[:, 0:3] = means.astype(np.float32)
    data[:, 3:6] = sh0.astype(np.float32)
    data[:, 6] = logit_opacities.astype(np.float32)
    data[:, 7:10] = log_scales.astype(np.float32)
    data[:, 10:14] = quats.astype(np.float32)

    with open(path, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(data.tobytes())
