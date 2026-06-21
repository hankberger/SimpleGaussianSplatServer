from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    model_config = {"env_prefix": "SPLAT_", "env_file": ".env"}

    # Paths
    jobs_dir: Path = Path("jobs")
    ffmpeg_path: str = "ffmpeg"
    ffprobe_path: str = "ffprobe"

    # Frame extraction
    default_max_frames: int = 50
    min_frames: int = 8
    default_resolution: int = 768
    dust3r_resolution: int = 512
    scene_change_threshold: float = 0.18
    blur_drop_ratio: float = 0.20
    min_frames_after_blur: int = 12

    # DUSt3R
    dust3r_model: str = "naver/DUSt3R_ViTLarge_BaseDecoder_512_dpt"
    # Global-alignment iterations dominate pose time. 100 converges enough here;
    # the joint pose optimization during training corrects residual error.
    dust3r_alignment_iters: int = 100
    dust3r_max_pairs_complete: int = 20
    dust3r_max_points: int = 500_000
    dust3r_confidence_threshold: float = 1.5
    # Half-precision DUSt3R pairwise inference — the ViT-Large forward dominates
    # pose-estimation time, and autocast roughly halves it. bf16 is the safe
    # default on Ada/Ampere (no overflow); set "fp16" if bf16 is unavailable.
    dust3r_amp: bool = True
    dust3r_amp_dtype: str = "bf16"

    # gsplat training
    default_training_iterations: int = 10000
    lr_means: float = 1.6e-4
    lr_means_final: float = 1.6e-6
    lr_scales: float = 5e-3
    lr_quats: float = 1e-3
    lr_opacities: float = 5e-2
    lr_sh: float = 2.5e-3
    ssim_weight: float = 0.2
    # Compute the (relatively expensive) SSIM term every Nth step; other steps
    # use L1 only. 2 roughly halves SSIM cost with negligible quality impact.
    # Set to 1 to compute SSIM every step.
    ssim_every: int = 2
    # Render this many cameras per training step in one rasterization call.
    # >1 improves GPU utilization (fewer, larger steps); 1 = original behavior.
    cameras_per_step: int = 1
    sh_degree: int = 3
    # gsplat rasterization mode: "antialiased" compensates opacity for the 2D
    # dilation filter — cleaner edges/fewer aliasing artifacts than "classic".
    rasterize_mode: str = "antialiased"
    opacity_reset_interval: int = 3000
    densify_start: int = 500
    densify_end: int = 4000
    densify_interval: int = 100
    # Mixed precision (autocast) around the loss math. gsplat's CUDA rasterizer
    # runs fp32 regardless, so the gain is modest (mainly the SSIM conv) and it's
    # off by default. No GradScaler is used, so the strategy's gradient-based
    # densification thresholds stay in fp32.
    use_amp: bool = False
    # gsplat DefaultStrategy grow threshold (grow_grad2d). 0.0002 is gsplat's
    # default; higher = fewer Gaussians cloned/split = faster training. (The old
    # hand-rolled densifier used 0.00015, which over-grew under the new strategy
    # and inflated step time.)
    densify_grad_thresh: float = 0.0002
    densify_max_gaussians: int = 1_000_000
    knn_k: int = 4
    # Densification strategy: "mcmc" (fixed Gaussian budget = faster/predictable,
    # quality on par at a given budget) or "default" (classic grad-based growth).
    densify_strategy: str = "mcmc"
    # Hard Gaussian budget for MCMC. The main speed/quality dial — lower is
    # faster. Tune against your end-of-training `n_gaussians=` count.
    mcmc_cap_max: int = 350_000

    # Camera pose optimization — refine the approximate DUSt3R poses jointly
    # with the Gaussians via a learnable per-camera SE(3) correction.
    pose_opt_enabled: bool = True
    pose_opt_lr: float = 1e-5
    pose_opt_start: int = 500  # warm up Gaussians before correcting poses

    # PPISP (photometric post-processing)
    ppisp_reg_weight: float = 0.01

    # Preview thumbnail (rendered after training for client previews)
    preview_max_dim: int = 1024
    preview_webp_quality: int = 85

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
