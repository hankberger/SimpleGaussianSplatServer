import logging
from contextlib import contextmanager

logger = logging.getLogger(__name__)


def get_gpu_memory_info() -> dict:
    """Return GPU memory stats in MB (torch optional — DUSt3R/preview need it,
    but a COLMAP+LichtFeld-only deploy can run without torch installed). When
    torch is absent we fall back to `nvidia-smi` so /health still reports the GPU
    (LichtFeld + COLMAP use it directly regardless of torch)."""
    try:
        import torch
    except ImportError:
        return _nvidia_smi_info()
    if not torch.cuda.is_available():
        return _nvidia_smi_info()
    props = torch.cuda.get_device_properties(0)
    total = props.total_memory // (1024 * 1024)
    reserved = torch.cuda.memory_reserved(0) // (1024 * 1024)
    allocated = torch.cuda.memory_allocated(0) // (1024 * 1024)
    free = total - reserved
    return {
        "available": True,
        "name": props.name,
        "total_mb": total,
        "used_mb": allocated,
        "reserved_mb": reserved,
        "free_mb": free,
    }


def _nvidia_smi_info() -> dict:
    """GPU stats via `nvidia-smi` (no torch needed)."""
    import shutil
    import subprocess

    smi = shutil.which("nvidia-smi")
    if not smi:
        return {"available": False}
    try:
        out = subprocess.run(
            [smi, "--query-gpu=name,memory.total,memory.used,memory.free",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10,
        )
        if out.returncode != 0 or not out.stdout.strip():
            return {"available": False}
        name, total, used, free = [s.strip() for s in out.stdout.strip().splitlines()[0].split(",")]
        return {
            "available": True, "name": name,
            "total_mb": int(float(total)), "used_mb": int(float(used)),
            "reserved_mb": int(float(used)), "free_mb": int(float(free)),
        }
    except Exception:
        return {"available": False}


def force_gpu_cleanup():
    """Aggressively free GPU memory (no-op without torch/CUDA)."""
    import gc

    gc.collect()
    try:
        import torch
    except ImportError:
        return
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.ipc_collect()
    logger.info("GPU cleanup complete. %s", get_gpu_memory_info())


@contextmanager
def gpu_memory_guard():
    """Context manager that cleans up GPU memory on exit or error."""
    try:
        yield
    finally:
        force_gpu_cleanup()
