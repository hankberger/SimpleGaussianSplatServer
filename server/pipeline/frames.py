import json
import logging
import subprocess
from pathlib import Path

import cv2
import numpy as np

from server.config import settings

logger = logging.getLogger(__name__)


def _run_cmd(cmd: list[str], description: str) -> subprocess.CompletedProcess:
    logger.info("Running %s: %s", description, " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"{description} failed: {result.stderr[:500]}")
    return result


def get_video_info(video_path: Path) -> dict:
    """Get video metadata via ffprobe."""
    cmd = [
        settings.ffprobe_path,
        "-v", "quiet",
        "-print_format", "json",
        "-show_streams",
        "-show_format",
        "-show_entries", "stream_side_data=rotation",
        str(video_path),
    ]
    result = _run_cmd(cmd, "ffprobe")
    info = json.loads(result.stdout)
    video_stream = next(
        (s for s in info.get("streams", []) if s["codec_type"] == "video"), None
    )
    if not video_stream:
        raise ValueError("No video stream found")
    duration = float(info.get("format", {}).get("duration", 0))
    fps_parts = video_stream.get("r_frame_rate", "30/1").split("/")
    fps = float(fps_parts[0]) / float(fps_parts[1]) if len(fps_parts) == 2 else 30.0

    w = int(video_stream["width"])
    h = int(video_stream["height"])

    # iOS MOV files store rotation as metadata rather than rotating pixels.
    # ffmpeg auto-rotates during decoding, so the actual output dimensions
    # are swapped for 90/270 degree rotations. Match that here.
    rotation = 0
    for side_data in video_stream.get("side_data_list", []):
        if "rotation" in side_data:
            rotation = abs(int(side_data["rotation"]))
            break
    # Also check the older top-level tag format
    if rotation == 0:
        rotation = abs(int(video_stream.get("tags", {}).get("rotate", 0)))

    if rotation in (90, 270):
        w, h = h, w
        logger.info("Rotation metadata=%d°, swapping dimensions to %dx%d", rotation, w, h)

    return {
        "width": w,
        "height": h,
        "duration": duration,
        "fps": fps,
        "total_frames": int(duration * fps) if duration else 0,
    }


def extract_frames(
    video_path: Path,
    output_dir: Path,
    max_frames: int = 40,
    resolution: int = 512,
) -> list[Path]:
    """Extract keyframes from video using scene detection with uniform fallback."""
    output_dir.mkdir(parents=True, exist_ok=True)
    video_info = get_video_info(video_path)
    logger.info("Video info: %s", video_info)

    # Determine scale filter (long edge to resolution)
    w, h = video_info["width"], video_info["height"]
    if w >= h:
        scale_filter = f"scale={resolution}:-2"
    else:
        scale_filter = f"scale=-2:{resolution}"

    # Try scene-change detection first
    frames = _extract_scene_frames(
        video_path, output_dir, max_frames, scale_filter, settings.scene_change_threshold
    )

    # Fallback to uniform temporal sampling if too few frames
    if len(frames) < settings.min_frames:
        logger.info(
            "Scene detection yielded %d frames (< %d), falling back to uniform sampling",
            len(frames),
            settings.min_frames,
        )
        # Clean up scene-detected frames
        for f in frames:
            f.unlink(missing_ok=True)
        frames = _extract_uniform_frames(
            video_path, output_dir, max_frames, scale_filter, video_info
        )

    logger.info("Extracted %d frames", len(frames))
    return frames


def _extract_scene_frames(
    video_path: Path,
    output_dir: Path,
    max_frames: int,
    scale_filter: str,
    threshold: float,
) -> list[Path]:
    """Extract frames at scene changes using ffmpeg select filter."""
    output_pattern = str(output_dir / "frame_%04d.png")
    cmd = [
        settings.ffmpeg_path,
        "-hwaccel", "cuda",
        "-i", str(video_path),
        "-vf", f"select='gt(scene,{threshold})',{scale_filter}",
        "-vsync", "vfr",
        "-frames:v", str(max_frames),
        "-q:v", "2",
        output_pattern,
        "-y",
    ]
    try:
        _run_cmd(cmd, "ffmpeg scene extraction")
    except RuntimeError:
        # Retry without hwaccel if CUDA decode not available
        logger.warning("CUDA hwaccel failed, retrying without")
        cmd = [c for c in cmd if c != "cuda" and c != "-hwaccel"]
        _run_cmd(cmd, "ffmpeg scene extraction (CPU)")

    frames = sorted(output_dir.glob("frame_*.png"))
    return frames


def _extract_uniform_frames(
    video_path: Path,
    output_dir: Path,
    max_frames: int,
    scale_filter: str,
    video_info: dict,
) -> list[Path]:
    """Extract frames at uniform temporal intervals."""
    duration = video_info["duration"]
    if duration <= 0:
        raise ValueError("Cannot determine video duration for uniform sampling")

    # Calculate interval to get max_frames evenly spaced
    fps_out = max_frames / duration
    output_pattern = str(output_dir / "frame_%04d.png")
    cmd = [
        settings.ffmpeg_path,
        "-hwaccel", "cuda",
        "-i", str(video_path),
        "-vf", f"fps={fps_out:.4f},{scale_filter}",
        "-frames:v", str(max_frames),
        "-q:v", "2",
        output_pattern,
        "-y",
    ]
    try:
        _run_cmd(cmd, "ffmpeg uniform extraction")
    except RuntimeError:
        logger.warning("CUDA hwaccel failed, retrying without")
        cmd = [c for c in cmd if c != "cuda" and c != "-hwaccel"]
        _run_cmd(cmd, "ffmpeg uniform extraction (CPU)")

    frames = sorted(output_dir.glob("frame_*.png"))
    return frames


def filter_blurry_frames(
    frame_paths: list[Path],
    drop_ratio: float = 0.20,
    min_keep: int = 12,
) -> list[Path]:
    """Filter out blurry frames using Laplacian variance."""
    if len(frame_paths) <= min_keep:
        return frame_paths

    sharpness = []
    for path in frame_paths:
        img = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if img is None:
            sharpness.append(0.0)
            continue
        lap_var = cv2.Laplacian(img, cv2.CV_64F).var()
        sharpness.append(lap_var)

    sharpness = np.array(sharpness)
    n_drop = max(0, int(len(frame_paths) * drop_ratio))
    n_keep = max(min_keep, len(frame_paths) - n_drop)

    # Keep the n_keep sharpest frames, preserving original order
    keep_indices = np.argsort(sharpness)[-n_keep:]
    keep_indices = np.sort(keep_indices)

    kept = [frame_paths[i] for i in keep_indices]
    dropped = set(range(len(frame_paths))) - set(keep_indices)
    for i in dropped:
        frame_paths[i].unlink(missing_ok=True)

    logger.info(
        "Blur filter: kept %d/%d frames (dropped %d)",
        len(kept),
        len(frame_paths),
        len(dropped),
    )
    return kept
