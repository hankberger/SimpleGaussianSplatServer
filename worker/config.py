from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    model_config = {"env_prefix": "SPLAT_", "env_file": ".env"}

    # Paths
    jobs_dir: Path = Path("jobs")
    ffmpeg_path: str = "ffmpeg"
    ffprobe_path: str = "ffprobe"

    # Frame extraction
    # "uniform" samples frames at even temporal spacing (correct for a single
    # continuous phone capture — even baselines = even parallax = better poses).
    # "scene" uses ffmpeg scene-change detection (meant for cuts in edited video;
    # fires erratically on a continuous orbit, leaving uneven coverage). Uniform
    # is the default; both fall back to the other if they yield too few frames.
    frame_extraction_mode: str = "uniform"
    # Coverage is the dominant quality lever. ~2 fps (~120 frames for a ~60s clip)
    # gives dense overlap + long feature tracks, matching the proven COLMAP recipe.
    # (Drop to ~64 for faster debug iteration.)
    default_max_frames: int = 120
    min_frames: int = 8
    default_resolution: int = 768
    # DUSt3R's working resolution for pose estimation. MUST stay 512: the
    # 512_dpt model is trained at 512 and 384 wrecked pose accuracy (visibly the
    # worst output). Since the global aligner holds a per-image depthmap at this
    # res and can't be streamed, 512 is what caps frame count on 24GB (~48-50
    # frames). Intrinsics are rescaled from here to default_resolution.
    dust3r_resolution: int = 512
    scene_change_threshold: float = 0.18
    blur_drop_ratio: float = 0.20
    min_frames_after_blur: int = 12

    # Pose backend — COLMAP (geometric SfM: SIFT + bundle adjustment, sub-pixel
    # accurate, CPU-bound) is tried first; on failure or too few registered
    # cameras it falls back to DUSt3R (learned, robust on hard/low-texture/
    # few-frame captures). COLMAP is far more accurate for a normal textured
    # phone orbit AND avoids DUSt3R's global-alignment GPU-memory wall.
    colmap_enabled: bool = True
    # Fall back to DUSt3R if COLMAP registers fewer than this fraction of frames —
    # a sparse partial reconstruction is worse than DUSt3R's full (if approximate)
    # set. Also floored at min_frames.
    colmap_min_registered_frac: float = 0.5
    # Camera model COLMAP fits, then undistorts to. OPENCV (k1,k2,p1,p2: full
    # radial + tangential) is REQUIRED for phone lenses — the pycolmap default
    # SIMPLE_RADIAL (single k1) under-corrects and leaves visible residual
    # distortion after undistortion. This is the proven recipe's model.
    colmap_camera_model: str = "OPENCV"
    # Save the COLMAP dataset (images + sparse model, standard 3DGS layout) as a
    # downloadable zip per job, for debugging — lets you load OUR exact COLMAP
    # output into another trainer (LichtFeld etc.) to bisect COLMAP vs training.
    colmap_save_dataset: bool = True
    # Feature matcher. KEEP "exhaustive". We tried "sequential" (O(n), faster) but
    # it gave WEAK reconstructions on real captures (93/120 registered but only
    # 7685 points + many "no good initial pair" -> distorted) vs exhaustive's clean
    # 52/52 + 11008 points. Sequential is fragile here: 768px frames have few SIFT
    # features, and a blurry frame between two sharp ones breaks its consecutive-
    # match chain. Exhaustive tries all pairs, so it's robust to both. Cost: O(n^2),
    # ~5-7 min on CPU SIFT at 120 frames (drop default_max_frames for faster iter).
    colmap_matcher: str = "exhaustive"

    # DUSt3R (fallback pose backend)
    dust3r_model: str = "naver/DUSt3R_ViTLarge_BaseDecoder_512_dpt"
    # Frame cap for the DUSt3R fallback only: its global alignment holds all views
    # jointly on the GPU, so the full ~120-frame set (sized for COLMAP) would OOM.
    # The dispatcher uniformly subsamples to this before running DUSt3R.
    dust3r_max_frames: int = 50
    # Global-alignment iterations. This is the cheap optimization step (not the
    # ViT forward), and 100 often hasn't converged on a multi-image graph, giving
    # drifted poses that show up as ghosting/blobs no later stage can fix. 300
    # matches DUSt3R's own demos for a modest time cost.
    dust3r_alignment_iters: int = 500
    dust3r_max_pairs_complete: int = 20
    # Sliding-window size for the pose graph when there are too many images for a
    # complete graph. swin-N is cyclic (wraps last->first), so it provides loop
    # closure for an orbit. A wider window adds connectivity (less drift) at the
    # cost of more pairs (~N x images) to run through the ViT.
    dust3r_swin_window: int = 6
    # Initial point-cloud size handed to training. 500k over-seeds densification
    # (grew to ~1.7M Gaussians); ~150k is a lighter init -> fewer final Gaussians
    # and faster training, like typical SfM-seeded 3DGS.
    dust3r_max_points: int = 150_000
    dust3r_confidence_threshold: float = 1.5
    # Half-precision DUSt3R pairwise inference — the ViT-Large forward dominates
    # pose-estimation time, and autocast roughly halves it. bf16 is the safe
    # default on Ada/Ampere (no overflow); set "fp16" if bf16 is unavailable.
    dust3r_amp: bool = True
    dust3r_amp_dtype: str = "bf16"

    # gsplat training
    # 10000 for final quality (geometry is visible by ~3k; the rest sharpens
    # detail). Drop to ~3000 for faster debug iteration.
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
    # Raised from gsplat's 0.0002 default: with sparse views the default over-
    # clones into ~850k Gaussians, ~22% of them near-transparent floaters. 0.0003
    # densifies more conservatively -> fewer floaters/fog.
    densify_grad_thresh: float = 0.0003
    densify_max_gaussians: int = 1_000_000
    knn_k: int = 4
    # Densification strategy: "default" (classic grad-based grow/split/clone/prune)
    # or "mcmc" (fixed budget via cap_max). MCMC injects per-step positional noise
    # and is meant to GROW from a sparse init; our DUSt3R init is dense, so MCMC
    # both no-ops the cap (init > cap) and distorts geometry — keep "default".
    densify_strategy: str = "default"
    # Hard Gaussian budget for MCMC. The main speed/quality dial — lower is
    # faster. Tune against your end-of-training `n_gaussians=` count.
    mcmc_cap_max: int = 350_000

    # Camera pose optimization — refine the approximate DUSt3R poses jointly
    # with the Gaussians via a learnable per-camera SE(3) correction. This is the
    # main lever that fixes residual pose error (the cause of blobby/ghosted
    # results). 1e-5 was ~100x too low to move the deltas meaningfully over
    # training; 1e-3 (standard for 3DGS camera refinement) actually corrects the
    # poses, decaying to pose_opt_lr_final so late training stays stable.
    pose_opt_enabled: bool = True
    pose_opt_lr: float = 1e-3
    pose_opt_lr_final: float = 1e-5
    pose_opt_start: int = 500  # warm up Gaussians before correcting poses

    # PPISP (photometric post-processing). OFF by default: it corrects per-frame
    # exposure/white-balance during training, but those corrections are NOT
    # applied at export, so under-regularized it can leave a slight global color
    # shift in the final splat. It's a small polish at best and never fixes
    # geometry — re-enable only once poses/coverage are solid.
    ppisp_enabled: bool = False
    ppisp_reg_weight: float = 0.01

    # Splat cleanup — post-training pruning of low-confidence Gaussians, run as
    # its own pipeline stage on the exported PLY before conversion.
    cleanup_enabled: bool = True
    # Drop Gaussians whose rendered opacity (sigmoid of the stored logit) is
    # below this. Kept moderate: sharp surfaces are built from many overlapping
    # semi-transparent splats, so a high opacity floor strips detail and leaves
    # the scene looking blobbier. Geometry passes below do the heavy lifting.
    cleanup_min_opacity: float = 0.05
    # Drop oversized blobs by EITHER test (the absolute cap catches blobs the
    # relative one misses when many blobs inflate the median). <=0 disables each.
    #  - relative: largest world-space scale > N x the median scale.
    cleanup_max_scale_ratio: float = 8.0
    #  - absolute: largest world-space scale > fraction of the scene radius.
    cleanup_max_scale_scene_frac: float = 0.08
    # Scattered-floater removal via statistical outlier removal (SOR): flag
    # Gaussians whose mean distance to their k nearest neighbors exceeds
    # cleanup_sor_dist_ratio x the median (i.e. that much more isolated than a
    # typical Gaussian). ~20 targets the clear outlier tail (~top 5%); lower is
    # more aggressive. (Replaced a connected-components pass that removed nothing
    # on dense clouds.)
    cleanup_floater_enabled: bool = True
    cleanup_floater_k: int = 8
    cleanup_sor_dist_ratio: float = 20.0
    # Upper bound on the floater pass: if more points flag than this fraction,
    # only the worst (largest mean-kNN distance) up to the cap are dropped, so a
    # heavy floater load still gets trimmed instead of gutting the whole scene.
    cleanup_floater_max_remove_frac: float = 0.15

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
