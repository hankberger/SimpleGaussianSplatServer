import logging
import os
from pathlib import Path

import numpy as np
from plyfile import PlyData, PlyElement

from worker.config import settings

logger = logging.getLogger(__name__)


def clean_ply(ply_path: Path) -> tuple[Path, dict]:
    """Prune low-confidence Gaussians from a trained 3DGS PLY, in place.

    The passes are deliberately built on *robust* statistics so they keep working
    when a large fraction of the cloud is junk (the case where mean/std- and
    median-ratio-based culls collapse, because the junk pollutes the statistic
    it's measured against):

      1. Low opacity        — Gaussians whose rendered opacity (sigmoid of the
                              stored logit) is below ``cleanup_min_opacity``.
      2. Oversized blobs    — Gaussians whose largest world-space scale exceeds
                              EITHER ``cleanup_max_scale_ratio`` x the median
                              scale OR ``cleanup_max_scale_scene_frac`` x the
                              scene radius (the absolute cap catches blobs the
                              relative test misses when the median is polluted).
      3. Scattered floaters — statistical outlier removal (SOR): a Gaussian
                              floating off the surface has a large mean distance
                              to its k nearest neighbors. Flag points whose
                              mean-kNN distance exceeds ``cleanup_sor_dist_ratio``
                              x the median, bounded by
                              ``cleanup_floater_max_remove_frac``. (Replaced a
                              connected-components pass that mis-calibrated on
                              dense clouds and removed nothing.)

    Writes the filtered cloud back over ``ply_path`` atomically and returns
    ``(ply_path, stats)``. Non-fatal: any failure leaves the original PLY intact
    and returns ``stats={"skipped": True, ...}`` so a cleanup bug never fails an
    otherwise-successful job.
    """
    stats: dict = {"input": 0, "kept": 0, "removed": 0}
    try:
        plydata = PlyData.read(str(ply_path))
        vert = plydata["vertex"]
        data = vert.data
        n0 = len(data)
        stats["input"] = n0
        if n0 == 0:
            stats.update(kept=0, removed=0)
            return ply_path, stats

        xyz = np.stack([data["x"], data["y"], data["z"]], axis=-1).astype(np.float32)
        keep = np.ones(n0, dtype=bool)

        # 1) Low opacity
        opacity_logit = np.asarray(data["opacity"], dtype=np.float32)
        opacity = 1.0 / (1.0 + np.exp(-opacity_logit))  # sigmoid
        low_op = opacity < settings.cleanup_min_opacity
        keep &= ~low_op
        stats["removed_low_opacity"] = int(low_op.sum())

        # 2) Oversized blobs — relative (median multiple) OR absolute (scene frac)
        log_scales = np.stack(
            [data["scale_0"], data["scale_1"], data["scale_2"]], axis=-1
        ).astype(np.float32)
        max_scale = np.exp(log_scales).max(axis=-1)
        oversized = np.zeros(n0, dtype=bool)
        if settings.cleanup_max_scale_ratio > 0 and keep.any():
            median_scale = float(np.median(max_scale[keep]))
            if median_scale > 0:
                oversized |= max_scale > median_scale * settings.cleanup_max_scale_ratio
        if settings.cleanup_max_scale_scene_frac > 0 and keep.any():
            scene_radius = _scene_radius(xyz[keep])
            if scene_radius > 0:
                oversized |= max_scale > scene_radius * settings.cleanup_max_scale_scene_frac
        newly_oversized = oversized & keep
        keep &= ~oversized
        stats["removed_oversized"] = int(newly_oversized.sum())

        # 3) Scattered floaters via statistical outlier removal (SOR). A floater
        #    sits far from the surface, so its mean distance to its k nearest
        #    neighbors is large. The score distribution on a (heavily densified)
        #    3DGS cloud is a continuum with a pathologically tight core, so an
        #    absolute multiple of the MEDIAN score is the robust separator: a
        #    Gaussian cleanup_sor_dist_ratio x more isolated than the typical one
        #    is a floater. Bounded by cleanup_floater_max_remove_frac: if more
        #    flag than the cap, drop only the worst (largest mean-kNN) up to it.
        if settings.cleanup_floater_enabled and keep.sum() > settings.cleanup_floater_k + 1:
            survivors = np.flatnonzero(keep)
            scores = _knn_mean_distance(xyz[survivors], settings.cleanup_floater_k)
            med = float(np.median(scores))
            thresh = med * settings.cleanup_sor_dist_ratio if med > 0 else np.inf
            flagged = scores > thresh
            cap = int(settings.cleanup_floater_max_remove_frac * len(survivors))
            if int(flagged.sum()) > cap > 0:
                # Too many flagged — keep removal bounded to the worst `cap`.
                drop_idx = np.argpartition(scores, -cap)[-cap:]
                drop_local = np.zeros(len(survivors), dtype=bool)
                drop_local[drop_idx] = True
            else:
                drop_local = flagged
            keep[survivors[drop_local]] = False
            stats["removed_floaters"] = int(drop_local.sum())

        kept = int(keep.sum())
        stats["kept"] = kept
        stats["removed"] = n0 - kept

        # Atomic in-place rewrite preserving the exact property layout.
        filtered = data[keep]
        out_elem = PlyElement.describe(filtered, "vertex")
        tmp_path = ply_path.with_suffix(".cleaned.ply")
        PlyData([out_elem], text=False, byte_order="<").write(str(tmp_path))
        os.replace(tmp_path, ply_path)

        logger.info(
            "Cleanup: %d -> %d Gaussians (removed %d: %d low-opacity, %d oversized, %d floaters)",
            n0,
            kept,
            stats["removed"],
            stats.get("removed_low_opacity", 0),
            stats.get("removed_oversized", 0),
            stats.get("removed_floaters", 0),
        )
        return ply_path, stats

    except Exception:
        logger.warning("Splat cleanup failed (non-fatal); keeping unpruned PLY", exc_info=True)
        stats["skipped"] = True
        return ply_path, stats


def _scene_radius(xyz: np.ndarray) -> float:
    """Robust scene radius: 95th-percentile distance from the centroid."""
    centroid = xyz.mean(axis=0)
    d = np.linalg.norm(xyz - centroid, axis=1)
    return float(np.percentile(d, 95))


def _knn_mean_distance(pts: np.ndarray, k: int) -> np.ndarray:
    """Mean distance from each point to its k nearest (non-self) neighbors.

    The SOR floater score: small for dense surface points, large for Gaussians
    floating in otherwise-empty space.
    """
    from scipy.spatial import cKDTree

    n = len(pts)
    k = min(k, n - 1)
    tree = cKDTree(pts)
    dists, _ = tree.query(pts, k=k + 1)  # col 0 is the point itself
    return dists[:, 1:].mean(axis=1)
