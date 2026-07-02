"""Self-contained writer for COLMAP's binary sparse-model format
(``cameras.bin`` / ``images.bin`` / ``points3D.bin``).

Used by the DUSt3R fallback to emit a dataset in the *exact* layout LichtFeld
Studio (and any COLMAP-based 3DGS trainer) consumes, without depending on a
particular pycolmap version's Reconstruction-construction API. The COLMAP path
gets its binaries straight from ``pycolmap.undistort_images``; this module is
only for synthesizing a model from learned poses.

Format reference: COLMAP ``src/colmap/scene/reconstruction.cc`` (little-endian).
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

# COLMAP camera model ids. PINHOLE (fx, fy, cx, cy) is what an undistorted /
# learned pinhole camera maps to; it is the model 3DGS trainers expect.
CAMERA_MODEL_IDS = {"SIMPLE_PINHOLE": 0, "PINHOLE": 1}


@dataclass
class Camera:
    id: int
    model: str  # "PINHOLE"
    width: int
    height: int
    params: list[float]  # PINHOLE -> [fx, fy, cx, cy]


@dataclass
class Image:
    id: int
    qvec: tuple[float, float, float, float]  # (w, x, y, z), world->cam
    tvec: tuple[float, float, float]  # world->cam translation
    camera_id: int
    name: str
    xys: np.ndarray = field(default_factory=lambda: np.zeros((0, 2), np.float64))
    point3D_ids: np.ndarray = field(default_factory=lambda: np.zeros((0,), np.int64))


@dataclass
class Point3D:
    id: int
    xyz: tuple[float, float, float]
    rgb: tuple[int, int, int]
    error: float = 1.0


def rotmat_to_qvec(R: np.ndarray) -> tuple[float, float, float, float]:
    """3x3 rotation matrix -> quaternion (w, x, y, z), COLMAP's ordering.

    Uses the symmetric-matrix eigenvector method (numerically stable for any
    valid rotation), matching COLMAP's own ``RotationMatrixToQuaternion``.
    """
    Rxx, Ryx, Rzx = R[0, 0], R[1, 0], R[2, 0]
    Rxy, Ryy, Rzy = R[0, 1], R[1, 1], R[2, 1]
    Rxz, Ryz, Rzz = R[0, 2], R[1, 2], R[2, 2]
    K = (
        np.array(
            [
                [Rxx - Ryy - Rzz, 0, 0, 0],
                [Ryx + Rxy, Ryy - Rxx - Rzz, 0, 0],
                [Rzx + Rxz, Rzy + Ryz, Rzz - Rxx - Ryy, 0],
                [Ryz - Rzy, Rzx - Rxz, Rxy - Ryx, Rxx + Ryy + Rzz],
            ]
        )
        / 3.0
    )
    eigvals, eigvecs = np.linalg.eigh(K)
    qvec = eigvecs[[3, 0, 1, 2], np.argmax(eigvals)]  # (w, x, y, z)
    if qvec[0] < 0:
        qvec = -qvec
    return float(qvec[0]), float(qvec[1]), float(qvec[2]), float(qvec[3])


def _w(f, fmt: str, *vals):
    f.write(struct.pack("<" + fmt, *vals))


def write_cameras_bin(cameras: list[Camera], path: Path) -> None:
    with open(path, "wb") as f:
        _w(f, "Q", len(cameras))
        for cam in cameras:
            model_id = CAMERA_MODEL_IDS[cam.model]
            _w(f, "i", cam.id)  # camera_id is uint32 but written as int32-width
            _w(f, "i", model_id)
            _w(f, "Q", cam.width)
            _w(f, "Q", cam.height)
            for p in cam.params:
                _w(f, "d", float(p))


def write_images_bin(images: list[Image], path: Path) -> None:
    with open(path, "wb") as f:
        _w(f, "Q", len(images))
        for im in images:
            _w(f, "i", im.id)
            _w(f, "dddd", *im.qvec)
            _w(f, "ddd", *im.tvec)
            _w(f, "i", im.camera_id)
            f.write(im.name.encode("utf-8") + b"\x00")
            n2d = int(len(im.xys))
            _w(f, "Q", n2d)
            for j in range(n2d):
                x, y = float(im.xys[j, 0]), float(im.xys[j, 1])
                pid = int(im.point3D_ids[j]) if len(im.point3D_ids) else -1
                _w(f, "dd", x, y)
                _w(f, "q", pid)  # int64; -1 == invalid


def write_points3D_bin(points: list[Point3D], path: Path) -> None:
    with open(path, "wb") as f:
        _w(f, "Q", len(points))
        for p in points:
            _w(f, "Q", p.id)
            _w(f, "ddd", *p.xyz)
            _w(f, "BBB", int(p.rgb[0]), int(p.rgb[1]), int(p.rgb[2]))
            _w(f, "d", float(p.error))
            _w(f, "Q", 0)  # empty track — trainers only read xyz/rgb for init


def write_model(
    sparse_dir: Path,
    cameras: list[Camera],
    images: list[Image],
    points: list[Point3D],
) -> None:
    """Write a full ``cameras.bin``/``images.bin``/``points3D.bin`` model."""
    sparse_dir.mkdir(parents=True, exist_ok=True)
    write_cameras_bin(cameras, sparse_dir / "cameras.bin")
    write_images_bin(images, sparse_dir / "images.bin")
    write_points3D_bin(points, sparse_dir / "points3D.bin")
