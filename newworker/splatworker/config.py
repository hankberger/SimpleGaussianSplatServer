from pathlib import Path

from pydantic_settings import BaseSettings

# This package lives at <newworker>/splatworker. The LichtFeld Studio
# distribution (bin/, lib/, share/) is unpacked at <newworker>/, so the
# launcher script sits next to it. Resolve it relative to this file so the
# worker runs from a checkout without any absolute paths baked in.
_PKG_DIR = Path(__file__).resolve().parent
_NEWWORKER_DIR = _PKG_DIR.parent


class Settings(BaseSettings):
    model_config = {"env_prefix": "SPLAT_", "env_file": ".env"}

    # --- Paths ---
    jobs_dir: Path = Path("jobs")
    ffmpeg_path: str = "ffmpeg"
    ffprobe_path: str = "ffprobe"

    # --- LichtFeld Studio (the trainer) ---
    # The launcher (run_lichtfeld.sh) sets LD_LIBRARY_PATH to ../lib and execs
    # the LichtFeld-Studio binary, so calling it is portable across machines.
    lichtfeld_bin: Path = _NEWWORKER_DIR / "bin" / "run_lichtfeld.sh"
    # Training strategy. "mrnf" is LichtFeld's MRNF strategy (the one we want);
    # "mcmc" and "igs+" are the other built-ins. (Legacy aliases: "mnrf", "lfs".)
    lichtfeld_strategy: str = "mrnf"
    # Max SH degree the trainer optimizes (0-3). 3 = full view-dependent color.
    lichtfeld_sh_degree: int = 3
    # Hard Gaussian budget. <=0 leaves it to the strategy's own default (MRNF
    # adapts its count), which is usually what you want for a phone capture;
    # set a positive value to pass --max-cap and bound memory/size.
    lichtfeld_max_cap: int = 0
    # Image downscale the trainer applies to dataset images: "auto", 1, 2, 4, 8.
    # We already extract+undistort frames at the target resolution, so train at
    # native (factor 1). "auto" lets LichtFeld cap very large inputs itself.
    lichtfeld_resize_factor: str = "1"
    # Hard wall-clock cap (seconds) on a single training run, so a stuck trainer
    # can't wedge the GPU lock forever. 0 disables.
    lichtfeld_timeout_s: int = 3600
    # Extra raw CLI args appended verbatim (space-split), for experiments without
    # a code change, e.g. "--bilateral-grid --eval".
    lichtfeld_extra_args: str = ""

    # --- Frame extraction ---
    # "uniform" samples at even temporal spacing — correct for one continuous
    # phone capture (even baselines = even parallax = better SfM). "scene" uses
    # ffmpeg scene-change detection (for edited cuts; fires erratically on an
    # orbit). Each falls back to the other if it yields too few frames.
    frame_extraction_mode: str = "uniform"
    # Coverage is the dominant quality lever for SfM. ~2 fps (~120 frames for a
    # ~60s clip) gives dense overlap + long feature tracks. Drop to ~64 for
    # faster debug iteration.
    default_max_frames: int = 120
    min_frames: int = 8
    # Long-edge resolution of extracted frames (and therefore the trained splat).
    default_resolution: int = 1280
    scene_change_threshold: float = 0.18
    # Blur filtering: with the COLMAP→LichtFeld path we register + train on the
    # full evenly-spaced set (LichtFeld/MRNF is robust and benefits from
    # coverage; dropping frames also leaves uneven baselines that weaken SfM).
    # The blur pass is therefore report-only by default — it logs how many frames
    # are soft without removing them. Set drop_blurry=True to actually cull.
    drop_blurry: bool = False
    blur_drop_ratio: float = 0.20
    min_frames_after_blur: int = 12

    # --- Pose backend: COLMAP (primary) ---
    # Geometric SfM (SIFT + bundle adjustment, sub-pixel accurate, CPU-bound).
    # Far more accurate than DUSt3R for a normal textured phone orbit, and it
    # sidesteps DUSt3R's global-alignment GPU-memory wall. DUSt3R is the fallback.
    colmap_enabled: bool = True
    # Fall back to DUSt3R if COLMAP registers fewer than this fraction of frames
    # (also floored at min_frames) — a sparse partial reconstruction is worse
    # than DUSt3R's full, if approximate, set.
    colmap_min_registered_frac: float = 0.5
    # Camera model COLMAP fits then undistorts to PINHOLE. OPENCV (k1,k2,p1,p2)
    # is required for phone lenses; the default SIMPLE_RADIAL under-corrects and
    # leaves residual distortion that a pinhole splat renderer can't reconcile.
    colmap_camera_model: str = "OPENCV"
    # Feature matcher. "exhaustive" (O(n^2)) is robust on real captures;
    # "sequential" (O(n)) is faster but fragile (a blurry frame breaks its
    # consecutive-match chain). Keep exhaustive unless iterating on time.
    colmap_matcher: str = "exhaustive"
    # Use the GPU for SIFT extraction/matching when available (much faster).
    colmap_use_gpu: bool = True

    # --- Pose backend: DUSt3R (fallback) ---
    dust3r_model: str = "naver/DUSt3R_ViTLarge_BaseDecoder_512_dpt"
    # DUSt3R's global alignment holds every view jointly on the GPU, so cap the
    # frame count for the fallback (the full ~120 set, sized for COLMAP, OOMs).
    dust3r_max_frames: int = 50
    # DUSt3R's trained working resolution. MUST be 512 (the 512_dpt model);
    # 384 wrecks pose accuracy. Intrinsics are rescaled to the training res.
    dust3r_resolution: int = 512
    dust3r_alignment_iters: int = 500
    dust3r_max_pairs_complete: int = 20
    dust3r_swin_window: int = 6
    dust3r_max_points: int = 150_000
    dust3r_confidence_threshold: float = 1.5
    # Half-precision DUSt3R pairwise inference (the ViT forward dominates time).
    # bf16 is safe on Ada/Ampere; set "fp16" if bf16 is unavailable.
    dust3r_amp: bool = True
    dust3r_amp_dtype: str = "bf16"

    # --- Defaults for job params (used when a request omits them) ---
    default_training_iterations: int = 30000

    # --- Debug dataset export ---
    # Save the COLMAP dataset (images/ + sparse/0/, standard 3DGS layout) as a
    # downloadable zip per job — lets you reload OUR exact dataset into LichtFeld
    # (or any COLMAP trainer) to bisect dataset quality vs training.
    save_dataset_zip: bool = True

    # --- Preview thumbnail (rendered from the final PLY for clients) ---
    preview_enabled: bool = True
    preview_max_dim: int = 1024
    preview_webp_quality: int = 85

    # --- Splat cleanup — post-training PLY pruning of low-confidence Gaussians ---
    cleanup_enabled: bool = True
    cleanup_min_opacity: float = 0.05
    cleanup_max_scale_ratio: float = 8.0
    cleanup_max_scale_scene_frac: float = 0.08
    cleanup_floater_enabled: bool = True
    cleanup_floater_k: int = 8
    cleanup_sor_dist_ratio: float = 20.0
    cleanup_floater_max_remove_frac: float = 0.15

    # --- Job management ---
    max_upload_size_mb: int = 500
    job_ttl_hours: int = 24
    cleanup_interval_minutes: int = 30

    # --- GPU ---
    gpu_device: str = "cuda:0"
    max_gpu_memory_fraction: float = 0.9

    # --- Queue (optional — set SPLAT_QUEUE_URL to enable remote job polling) ---
    queue_url: str = ""
    queue_api_key: str = ""
    queue_poll_interval: int = 5


settings = Settings()
