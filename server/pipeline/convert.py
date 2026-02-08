import logging
from io import BytesIO
from pathlib import Path

import numpy as np
from plyfile import PlyData

logger = logging.getLogger(__name__)

SH_C0 = 0.28209479177387814


def ply_to_splat(ply_path: Path, output_path: Path) -> Path:
    """Convert a 3DGS PLY file to .splat binary format (vectorized)."""
    plydata = PlyData.read(str(ply_path))
    vert = plydata["vertex"]
    n = len(vert.data)
    logger.info("Converting PLY with %d gaussians to SPLAT", n)

    # Extract all arrays at once
    x = vert["x"].astype(np.float32)
    y = vert["y"].astype(np.float32)
    z = vert["z"].astype(np.float32)
    scale_0 = vert["scale_0"].astype(np.float32)
    scale_1 = vert["scale_1"].astype(np.float32)
    scale_2 = vert["scale_2"].astype(np.float32)
    opacity = vert["opacity"].astype(np.float32)
    f_dc_0 = vert["f_dc_0"].astype(np.float32)
    f_dc_1 = vert["f_dc_1"].astype(np.float32)
    f_dc_2 = vert["f_dc_2"].astype(np.float32)
    rot_0 = vert["rot_0"].astype(np.float32)
    rot_1 = vert["rot_1"].astype(np.float32)
    rot_2 = vert["rot_2"].astype(np.float32)
    rot_3 = vert["rot_3"].astype(np.float32)

    # Sort by importance: -exp(s0+s1+s2) / sigmoid(opacity)
    importance = -np.exp(scale_0 + scale_1 + scale_2) / (1.0 + np.exp(-opacity))
    order = np.argsort(importance)

    # Apply sort order
    x, y, z = x[order], y[order], z[order]
    scale_0, scale_1, scale_2 = scale_0[order], scale_1[order], scale_2[order]
    opacity = opacity[order]
    f_dc_0, f_dc_1, f_dc_2 = f_dc_0[order], f_dc_1[order], f_dc_2[order]
    rot_0, rot_1, rot_2, rot_3 = rot_0[order], rot_1[order], rot_2[order], rot_3[order]

    # Build output buffer: 32 bytes per gaussian
    # [position: 3xf32][scales: 3xf32][color: 4xu8][rotation: 4xu8]
    buf = np.empty((n, 32), dtype=np.uint8)

    # Position (12 bytes)
    positions = np.stack([x, y, z], axis=-1)  # (N, 3) float32
    buf[:, 0:12] = positions.view(np.uint8).reshape(n, 12)

    # Scales (12 bytes) - exponentiated
    scales = np.exp(np.stack([scale_0, scale_1, scale_2], axis=-1))
    buf[:, 12:24] = scales.view(np.uint8).reshape(n, 12)

    # Color (4 bytes) - SH_C0 conversion + sigmoid opacity
    r = np.clip((0.5 + SH_C0 * f_dc_0) * 255, 0, 255).astype(np.uint8)
    g = np.clip((0.5 + SH_C0 * f_dc_1) * 255, 0, 255).astype(np.uint8)
    b = np.clip((0.5 + SH_C0 * f_dc_2) * 255, 0, 255).astype(np.uint8)
    a = np.clip((1.0 / (1.0 + np.exp(-opacity))) * 255, 0, 255).astype(np.uint8)
    buf[:, 24] = r
    buf[:, 25] = g
    buf[:, 26] = b
    buf[:, 27] = a

    # Rotation (4 bytes) - normalized quaternion, quantized to uint8
    quats = np.stack([rot_0, rot_1, rot_2, rot_3], axis=-1)
    norms = np.linalg.norm(quats, axis=-1, keepdims=True)
    norms = np.maximum(norms, 1e-10)
    quats_normed = quats / norms
    quats_u8 = np.clip(quats_normed * 128 + 128, 0, 255).astype(np.uint8)
    buf[:, 28:32] = quats_u8

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "wb") as f:
        f.write(buf.tobytes())

    logger.info("Wrote SPLAT file: %s (%d gaussians, %.1f MB)", output_path, n, n * 32 / 1e6)
    return output_path
