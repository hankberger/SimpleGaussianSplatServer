"""Render a representative thumbnail of the trained scene for client previews.

Loads the final PLY and one camera from the dataset's sparse model, rasterizes a
single view with gsplat, and writes ``preview.png`` + ``preview.webp`` next to
the result. Fully optional and non-fatal: if gsplat / torch / pycolmap aren't
available, or anything fails, the job still succeeds without a preview.
"""

import logging
from pathlib import Path
from typing import Optional

import numpy as np

from splatworker.config import settings

logger = logging.getLogger(__name__)

SH_C0 = 0.28209479177387814


def render_preview(ply_path: Path, dataset_dir: Path, output_dir: Path) -> Optional[Path]:
    if not settings.preview_enabled:
        return None
    try:
        import torch
        from gsplat import rasterization

        cam = _read_camera(dataset_dir)
        if cam is None:
            logger.warning("Preview: no camera in dataset; skipping")
            return None
        w2c, K, width, height = cam

        g = _load_gaussians(ply_path)
        device = settings.gpu_device
        means = torch.from_numpy(g["means"]).float().to(device)
        quats = torch.from_numpy(g["quats"]).float().to(device)
        scales = torch.from_numpy(np.exp(g["scales"])).float().to(device)
        opac = torch.from_numpy(1.0 / (1.0 + np.exp(-g["opacities"]))).float().to(device)
        colors = torch.from_numpy(g["colors"]).float().to(device)  # (N,1,3) SH DC

        viewmat = torch.from_numpy(w2c).float().to(device).unsqueeze(0)
        Kt = torch.from_numpy(K).float().to(device).unsqueeze(0)

        with torch.no_grad():
            renders, _, _ = rasterization(
                means=means,
                quats=quats / (quats.norm(dim=-1, keepdim=True) + 1e-8),
                scales=scales,
                opacities=opac,
                colors=colors,
                viewmats=viewmat,
                Ks=Kt,
                width=width,
                height=height,
                packed=False,
                sh_degree=0,
                rasterize_mode="antialiased",
            )
        img = renders[0].clamp(0.0, 1.0).cpu().numpy()
        return _save(img, output_dir)
    except Exception:
        logger.warning("Preview render failed (non-fatal)", exc_info=True)
        return None


def _read_camera(dataset_dir: Path):
    """Return (w2c 4x4, K 3x3, width, height) for a representative middle view."""
    import pycolmap

    rec = pycolmap.Reconstruction(dataset_dir / "sparse" / "0")
    images = list(rec.images.values())
    if not images:
        return None
    img = images[len(images) // 2]
    cam = rec.cameras[img.camera_id]

    cfw = img.cam_from_world
    if callable(cfw):
        cfw = cfw()
    w2c = np.eye(4, dtype=np.float64)
    w2c[:3, :4] = np.asarray(cfw.matrix(), dtype=np.float64)
    K = np.asarray(cam.calibration_matrix(), dtype=np.float64)
    return w2c, K, int(cam.width), int(cam.height)


def _load_gaussians(ply_path: Path) -> dict:
    from plyfile import PlyData

    v = PlyData.read(str(ply_path))["vertex"]
    means = np.stack([v["x"], v["y"], v["z"]], axis=-1).astype(np.float32)
    scales = np.stack([v["scale_0"], v["scale_1"], v["scale_2"]], axis=-1).astype(np.float32)
    quats = np.stack([v["rot_0"], v["rot_1"], v["rot_2"], v["rot_3"]], axis=-1).astype(np.float32)
    opacities = np.asarray(v["opacity"], dtype=np.float32)
    # DC SH only — a flat-shaded thumbnail is plenty for a preview.
    dc = np.stack([v["f_dc_0"], v["f_dc_1"], v["f_dc_2"]], axis=-1).astype(np.float32)
    colors = dc[:, None, :]  # (N, 1, 3)
    return {"means": means, "scales": scales, "quats": quats,
            "opacities": opacities, "colors": colors}


def _save(img: np.ndarray, output_dir: Path):
    import cv2

    img = (img * 255.0 + 0.5).astype(np.uint8)
    max_dim = settings.preview_max_dim
    h, w = img.shape[:2]
    if max(h, w) > max_dim:
        s = max_dim / max(h, w)
        img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    png_path = output_dir / "preview.png"
    webp_path = output_dir / "preview.webp"
    cv2.imwrite(str(png_path), bgr)
    cv2.imwrite(str(webp_path), bgr, [cv2.IMWRITE_WEBP_QUALITY, settings.preview_webp_quality])
    logger.info("Saved preview: %s, %s", png_path, webp_path)
    return webp_path
