"""DUSt3R (learned pose estimation) → a COLMAP/3DGS dataset directory.

The fallback for captures COLMAP can't register (low texture, too few frames,
fast motion). DUSt3R predicts dense pointmaps + camera poses; we convert those
into the *same* COLMAP-format dataset the COLMAP backend produces, so LichtFeld
trains through one path. Poses are approximate, but for a hard capture an
approximate full reconstruction beats a failed one.
"""

import logging
import shutil
import sys
from pathlib import Path

import numpy as np

from splatworker.config import settings
from splatworker.pipeline import colmap_io
from splatworker.utils.gpu import force_gpu_cleanup

logger = logging.getLogger(__name__)

# DUSt3R is cloned to <repo_root>/dust3r (newworker/../dust3r). Make it importable.
_DUST3R_REPO = Path(__file__).resolve().parents[3] / "dust3r"
if _DUST3R_REPO.exists() and str(_DUST3R_REPO) not in sys.path:
    sys.path.insert(0, str(_DUST3R_REPO))

_dust3r_model = None


def run_dust3r(frame_paths: list[Path], dataset_dir: Path, training_resolution: int) -> dict:
    """Run DUSt3R on (a subsample of) ``frame_paths`` and populate ``dataset_dir``.

    Returns a stats dict: ``{registered, total, points}``.
    """
    total = len(frame_paths)
    frames = _subsample(frame_paths, settings.dust3r_max_frames)

    poses, intrinsics, points, colors = _infer(
        frames, settings.dust3r_resolution, training_resolution
    )

    _write_dataset(frames, poses, intrinsics, points, colors, dataset_dir)
    return {"registered": len(frames), "total": total, "points": len(points)}


def _subsample(frame_paths: list[Path], cap: int) -> list[Path]:
    if len(frame_paths) <= cap:
        return list(frame_paths)
    idx = np.unique(np.linspace(0, len(frame_paths) - 1, cap).round().astype(int))
    sub = [frame_paths[i] for i in idx]
    logger.info("DUSt3R: subsampled %d -> %d frames for GPU memory", len(frame_paths), len(sub))
    return sub


def _load_model():
    global _dust3r_model
    if _dust3r_model is not None:
        return _dust3r_model
    import torch  # noqa: F401  (ensures torch present before model load)
    from dust3r.model import AsymmetricCroCo3DStereo

    logger.info("Loading DUSt3R model: %s", settings.dust3r_model)
    model = AsymmetricCroCo3DStereo.from_pretrained(settings.dust3r_model)
    model = model.to(settings.gpu_device)
    model.eval()
    _dust3r_model = model
    logger.info("DUSt3R model loaded")
    return _dust3r_model


def _infer(frame_paths, resolution, training_resolution):
    """Returns poses (N,4,4 cam2world), intrinsics (N,3,3 @ training res),
    points (M,3), colors (M,3 in [0,1]). Adapted from the v1 worker."""
    import torch
    from dust3r.cloud_opt import GlobalAlignerMode, global_aligner
    from dust3r.image_pairs import make_pairs
    from dust3r.inference import inference
    from dust3r.utils.image import load_images

    device = settings.gpu_device
    model = _load_model()

    images = load_images([str(p) for p in frame_paths], size=resolution)
    n_images = len(images)

    graph_mode = (
        "complete" if n_images <= settings.dust3r_max_pairs_complete
        else f"swin-{settings.dust3r_swin_window}"
    )
    logger.info("DUSt3R: %d images, graph=%s", n_images, graph_mode)
    pairs = make_pairs(images, scene_graph=graph_mode, prefilter=None, symmetrize=True)

    logger.info("DUSt3R: pairwise inference (amp=%s)",
                settings.dust3r_amp_dtype if settings.dust3r_amp else "off")
    if settings.dust3r_amp:
        amp_dtype = torch.bfloat16 if settings.dust3r_amp_dtype == "bf16" else torch.float16
        with torch.autocast(device_type="cuda", dtype=amp_dtype):
            output = inference(pairs, model, device, batch_size=1)
    else:
        output = inference(pairs, model, device, batch_size=1)

    mode = GlobalAlignerMode.PointCloudOptimizer if n_images > 2 else GlobalAlignerMode.PairViewer
    scene = global_aligner(output, device=device, mode=mode)
    if mode == GlobalAlignerMode.PointCloudOptimizer:
        loss = scene.compute_global_alignment(
            init="mst", niter=settings.dust3r_alignment_iters, schedule="cosine", lr=0.01
        )
        logger.info("DUSt3R: global alignment final loss: %.4f", float(loss))

    poses = scene.get_im_poses().detach().cpu().numpy()  # (N,4,4) cam2world
    K = scene.get_intrinsics().detach().cpu().numpy().astype(np.float32)  # (N,3,3)
    points, colors = _extract_point_cloud(scene, n_images)

    # DUSt3R runs at its own resolution; rescale intrinsics to the training res.
    if training_resolution != resolution:
        s = training_resolution / resolution
        K = K.copy()
        K[:, 0, :] *= s
        K[:, 1, :] *= s
        K[:, 2, :] = [0, 0, 1]

    del scene, output, pairs
    force_gpu_cleanup()
    return poses, K, points, colors


def _extract_point_cloud(scene, n_images):
    pts3d_list = scene.get_pts3d()
    conf_list = scene.get_masks()
    imgs = scene.imgs
    all_pts, all_cols = [], []
    for i in range(n_images):
        pts = pts3d_list[i].detach().cpu().numpy()
        mask = conf_list[i].detach().cpu().numpy()
        img = imgs[i]
        p = pts[mask]
        c = img[mask]
        valid = np.all(np.isfinite(p), axis=1)
        p, c = p[valid], c[valid]
        if len(p):
            mean, std = p.mean(0), p.std(0)
            inl = np.all(np.abs(p - mean) < 3 * std, axis=1)
            p, c = p[inl], c[inl]
        all_pts.append(p)
        all_cols.append(c)
    points = np.concatenate(all_pts, 0).astype(np.float32)
    colors = np.concatenate(all_cols, 0).astype(np.float32)
    if len(points) > settings.dust3r_max_points:
        idx = np.random.choice(len(points), settings.dust3r_max_points, replace=False)
        points, colors = points[idx], colors[idx]
    return points, np.clip(colors, 0.0, 1.0)


def _write_dataset(frames, poses, intrinsics, points, colors, dataset_dir: Path):
    """Copy images and write COLMAP binaries (cameras/images/points3D)."""
    import cv2

    images_dst = dataset_dir / "images"
    sparse_dst = dataset_dir / "sparse" / "0"
    images_dst.mkdir(parents=True, exist_ok=True)
    sparse_dst.mkdir(parents=True, exist_ok=True)

    cameras: list[colmap_io.Camera] = []
    images: list[colmap_io.Image] = []
    for i, src in enumerate(frames):
        dst = images_dst / src.name
        shutil.copy2(src, dst)
        img = cv2.imread(str(dst))
        h, w = img.shape[:2]

        K = intrinsics[i]
        fx = float(K[0, 0])
        fy = float(K[1, 1]) if K[1, 1] != 0 else fx
        cx = float(K[0, 2]) if K[0, 2] != 0 else w / 2.0
        cy = float(K[1, 2]) if K[1, 2] != 0 else h / 2.0
        cam_id = i + 1
        cameras.append(colmap_io.Camera(cam_id, "PINHOLE", w, h, [fx, fy, cx, cy]))

        # world->cam from cam->world pose.
        w2c = np.linalg.inv(poses[i].astype(np.float64))
        qvec = colmap_io.rotmat_to_qvec(w2c[:3, :3])
        tvec = (float(w2c[0, 3]), float(w2c[1, 3]), float(w2c[2, 3]))
        images.append(colmap_io.Image(i + 1, qvec, tvec, cam_id, src.name))

    rgb = np.clip(colors * 255.0 + 0.5, 0, 255).astype(np.uint8)
    pts3d = [
        colmap_io.Point3D(
            i + 1,
            (float(points[i, 0]), float(points[i, 1]), float(points[i, 2])),
            (int(rgb[i, 0]), int(rgb[i, 1]), int(rgb[i, 2])),
        )
        for i in range(len(points))
    ]
    colmap_io.write_model(sparse_dst, cameras, images, pts3d)
    logger.info("DUSt3R dataset written: %d cameras, %d points -> %s",
                len(cameras), len(pts3d), dataset_dir)
