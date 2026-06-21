import logging
from contextlib import contextmanager

import torch

logger = logging.getLogger(__name__)


def get_gpu_memory_info() -> dict:
    """Return GPU memory stats in MB."""
    if not torch.cuda.is_available():
        return {"available": False}
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


def force_gpu_cleanup():
    """Aggressively free GPU memory."""
    import gc

    gc.collect()
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
