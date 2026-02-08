from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    model_config = {"env_prefix": "SPLAT_", "env_file": ".env"}

    # Paths
    jobs_dir: Path = Path("jobs")
    ffmpeg_path: str = "ffmpeg"
    ffprobe_path: str = "ffprobe"

    # Frame extraction
    default_max_frames: int = 40
    min_frames: int = 8
    default_resolution: int = 768
    dust3r_resolution: int = 512
    scene_change_threshold: float = 0.18
    blur_drop_ratio: float = 0.20
    min_frames_after_blur: int = 12

    # DUSt3R
    dust3r_model: str = "naver/DUSt3R_ViTLarge_BaseDecoder_512_dpt"
    dust3r_alignment_iters: int = 200
    dust3r_max_pairs_complete: int = 20
    dust3r_max_points: int = 500_000
    dust3r_confidence_threshold: float = 1.5

    # gsplat training
    default_training_iterations: int = 7000
    lr_means: float = 1.6e-4
    lr_means_final: float = 1.6e-6
    lr_scales: float = 5e-3
    lr_quats: float = 1e-3
    lr_opacities: float = 5e-2
    lr_sh: float = 2.5e-3
    ssim_weight: float = 0.2
    densify_start: int = 500
    densify_end: int = 4000
    densify_interval: int = 100
    densify_grad_thresh: float = 0.0002
    densify_max_gaussians: int = 500_000
    knn_k: int = 4

    # Job management
    max_upload_size_mb: int = 500
    job_ttl_hours: int = 24
    cleanup_interval_minutes: int = 30

    # GPU
    gpu_device: str = "cuda:0"
    max_gpu_memory_fraction: float = 0.9

    # Queue (optional — set SPLAT_QUEUE_URL to enable remote job polling)
    queue_url: str = ""
    queue_api_key: str = ""
    queue_poll_interval: int = 5


settings = Settings()
