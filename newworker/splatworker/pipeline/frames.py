import json
import logging
import subprocess
from pathlib import Path

import cv2
import numpy as np

from splatworker.config import settings

logger = logging.getLogger(__name__)


def _run_cmd(cmd: list[str], description: str, timeout: int = 600) -> subprocess.CompletedProcess:
    logger.info("Running %s: %s", description, " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip() or "(no output)"
        raise RuntimeError(f"{description} failed (exit {result.returncode}): {detail[:500]}")
    return result


def normalize_video(video_path: Path) -> Path:
    """Re-encode video to H.264/MP4 if it isn't already. Returns the normalized path."""
    cmd = [
        settings.ffprobe_path, "-v", "error", "-print_format", "json",
        "-show_streams", str(video_path),
    ]
    result = _run_cmd(cmd, "ffprobe codec check")
    info = json.loads(result.stdout)
    video_stream = next(
        (s for s in info.get("streams", []) if s["codec_type"] == "video"), None
    )
    if not video_stream:
        raise ValueError("No video stream found in input file")

    codec = video_stream.get("codec_name", "").lower()
    container = video_path.suffix.lower()
    logger.info("Input video codec=%s container=%s", codec, container)
    if codec == "h264" and container == ".mp4":
        logger.info("Video is already H.264/MP4, skipping normalization")
        return video_path

    normalized_path = video_path.parent / "input_normalized.mp4"
    logger.info("Normalizing video from %s/%s to H.264/MP4", codec, container)
    cmd = [
        settings.ffmpeg_path, "-i", str(video_path),
        "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-an",
        str(normalized_path), "-y",
    ]
    _run_cmd(cmd, "video normalization to H.264/MP4")
    return normalized_path


def get_video_info(video_path: Path) -> dict:
    """Get video metadata via ffprobe (handles iOS rotation metadata)."""
    cmd = [
        settings.ffprobe_path, "-v", "error", "-print_format", "json",
        "-show_streams", "-show_format", str(video_path),
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

    # iOS MOV stores rotation as metadata; ffmpeg auto-rotates on decode, so the
    # actual output dimensions are swapped for 90/270. Match that here.
    rotation = 0
    for side_data in video_stream.get("side_data_list", []):
        if "rotation" in side_data:
            rotation = abs(int(side_data["rotation"]))
            break
    if rotation == 0:
        rotation = abs(int(video_stream.get("tags", {}).get("rotate", 0)))
    if rotation in (90, 270):
        w, h = h, w
        logger.info("Rotation metadata=%d°, swapping dimensions to %dx%d", rotation, w, h)

    return {
        "width": w, "height": h, "duration": duration, "fps": fps,
        "total_frames": int(duration * fps) if duration else 0,
    }


def extract_frames(
    video_path: Path, output_dir: Path, max_frames: int = 120, resolution: int = 1280
) -> list[Path]:
    """Extract frames (uniform temporal sampling by default; scene-change optional)."""
    output_dir.mkdir(parents=True, exist_ok=True)
    video_info = get_video_info(video_path)
    logger.info("Video info: %s", video_info)

    w, h = video_info["width"], video_info["height"]
    scale_filter = f"scale={resolution}:-2" if w >= h else f"scale=-2:{resolution}"

    if settings.frame_extraction_mode == "scene":
        frames = _extract_scene_frames(
            video_path, output_dir, max_frames, scale_filter, settings.scene_change_threshold
        )
        if len(frames) < settings.min_frames:
            logger.info("Scene detection yielded %d frames (< %d); using uniform",
                        len(frames), settings.min_frames)
            for f in frames:
                f.unlink(missing_ok=True)
            frames = _extract_uniform_frames(video_path, output_dir, max_frames, scale_filter, video_info)
    else:
        frames = _extract_uniform_frames(video_path, output_dir, max_frames, scale_filter, video_info)
        if len(frames) < settings.min_frames:
            logger.info("Uniform sampling yielded %d frames (< %d); using scene detection",
                        len(frames), settings.min_frames)
            for f in frames:
                f.unlink(missing_ok=True)
            frames = _extract_scene_frames(
                video_path, output_dir, max_frames, scale_filter, settings.scene_change_threshold
            )

    logger.info("Extracted %d frames", len(frames))
    return frames


def _extract_scene_frames(video_path, output_dir, max_frames, scale_filter, threshold):
    output_pattern = str(output_dir / "frame_%04d.png")
    cmd = [
        settings.ffmpeg_path, "-hwaccel", "cuda", "-i", str(video_path),
        "-vf", f"select='gt(scene,{threshold})',{scale_filter}",
        "-vsync", "vfr", "-frames:v", str(max_frames), "-q:v", "2",
        output_pattern, "-y",
    ]
    try:
        _run_cmd(cmd, "ffmpeg scene extraction")
    except RuntimeError:
        logger.warning("CUDA hwaccel failed, retrying without")
        cmd = [c for c in cmd if c not in ("cuda", "-hwaccel")]
        _run_cmd(cmd, "ffmpeg scene extraction (CPU)")
    return sorted(output_dir.glob("frame_*.png"))


def _extract_uniform_frames(video_path, output_dir, max_frames, scale_filter, video_info):
    duration = video_info["duration"]
    if duration <= 0:
        raise ValueError("Cannot determine video duration for uniform sampling")
    fps_out = max_frames / duration
    output_pattern = str(output_dir / "frame_%04d.png")
    cmd = [
        settings.ffmpeg_path, "-hwaccel", "cuda", "-i", str(video_path),
        "-vf", f"fps={fps_out:.4f},{scale_filter}",
        "-frames:v", str(max_frames), "-q:v", "2", output_pattern, "-y",
    ]
    try:
        _run_cmd(cmd, "ffmpeg uniform extraction")
    except RuntimeError:
        logger.warning("CUDA hwaccel failed, retrying without")
        cmd = [c for c in cmd if c not in ("cuda", "-hwaccel")]
        _run_cmd(cmd, "ffmpeg uniform extraction (CPU)")
    return sorted(output_dir.glob("frame_*.png"))


def _sharpness(frame_paths: list[Path]) -> np.ndarray:
    """Laplacian-variance sharpness per frame (higher = sharper)."""
    vals = []
    for path in frame_paths:
        img = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        vals.append(0.0 if img is None else cv2.Laplacian(img, cv2.CV_64F).var())
    return np.array(vals)


def select_sharp_frames(
    frame_paths: list[Path],
    drop: bool,
    drop_ratio: float = 0.20,
    min_keep: int = 12,
) -> tuple[list[Path], int]:
    """Return (frames_to_use, n_soft).

    With ``drop=False`` (the default for the COLMAP→LichtFeld path) nothing is
    removed — SfM registers and the trainer learns on the full evenly-spaced set
    (more coverage, even baselines), and we only report how many frames are soft.
    With ``drop=True`` the blurriest ``drop_ratio`` are culled (kept ≥ min_keep).
    """
    if len(frame_paths) <= min_keep:
        return frame_paths, 0

    sharpness = _sharpness(frame_paths)
    n_drop = max(0, int(len(frame_paths) * drop_ratio))
    n_keep = max(min_keep, len(frame_paths) - n_drop)
    keep_idx = np.sort(np.argsort(sharpness)[-n_keep:])
    n_soft = len(frame_paths) - len(keep_idx)

    if not drop:
        logger.info("Blur check: %d/%d frames soft (report-only; training on full set)",
                    n_soft, len(frame_paths))
        return frame_paths, n_soft

    kept = [frame_paths[i] for i in keep_idx]
    logger.info("Blur filter: kept %d/%d sharpest frames", len(kept), len(frame_paths))
    return kept, n_soft
