"""Training stage — drive LichtFeld Studio's headless trainer with the MRNF
strategy on the COLMAP-format dataset built by the pose stage.

LichtFeld is invoked as a subprocess (the launcher sets LD_LIBRARY_PATH and
execs the native binary). We stream its stdout to surface step/loss progress and
return the path to the exported ``.ply``.
"""

import logging
import re
import subprocess
import time
from pathlib import Path
from typing import Callable, Optional

from splatworker.config import settings

logger = logging.getLogger(__name__)

# Best-effort progress parsing. LichtFeld prints iteration progress to stdout;
# match a "<step>/<total>" pair anywhere on a line, and a loss if present.
_STEP_RE = re.compile(r"(\d+)\s*/\s*(\d+)")
_LOSS_RE = re.compile(r"loss[\s:=]+([0-9]+\.?[0-9]*(?:[eE][+-]?[0-9]+)?)", re.IGNORECASE)


def train(
    dataset_dir: Path,
    output_dir: Path,
    iterations: int,
    progress_cb: Optional[Callable[[int, float], None]] = None,
) -> Path:
    """Run LichtFeld training and return the exported PLY path."""
    output_dir.mkdir(parents=True, exist_ok=True)
    bin_path = settings.lichtfeld_bin
    if not Path(bin_path).exists():
        raise RuntimeError(f"LichtFeld binary not found: {bin_path}")

    cmd = _build_command(dataset_dir, output_dir, iterations)
    logger.info("Training (LichtFeld %s): %s", settings.lichtfeld_strategy, " ".join(cmd))

    _run(cmd, iterations, progress_cb)

    ply = _find_output_ply(output_dir)
    if ply is None:
        raise RuntimeError(f"LichtFeld produced no .ply in {output_dir}")
    logger.info("Training complete: %s (%.1f MB)", ply, ply.stat().st_size / 1e6)
    return ply


def _build_command(dataset_dir: Path, output_dir: Path, iterations: int) -> list[str]:
    cmd = [
        str(settings.lichtfeld_bin),
        "--headless",
        "--train",
        "-d", str(dataset_dir),
        "-o", str(output_dir),
        "--images", "images",
        "--strategy", settings.lichtfeld_strategy,
        "-i", str(iterations),
        "--sh-degree", str(settings.lichtfeld_sh_degree),
        "-r", str(settings.lichtfeld_resize_factor),
    ]
    if settings.lichtfeld_max_cap > 0:
        cmd += ["--max-cap", str(settings.lichtfeld_max_cap)]
    if settings.lichtfeld_extra_args.strip():
        cmd += settings.lichtfeld_extra_args.split()
    return cmd


def _run(cmd: list[str], iterations: int, progress_cb):
    """Run the trainer, streaming stdout to logs + the progress callback."""
    timeout = settings.lichtfeld_timeout_s
    start = time.time()
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.rstrip()
            if line:
                logger.info("[lichtfeld] %s", line)
                _emit_progress(line, iterations, progress_cb)
            if timeout and (time.time() - start) > timeout:
                proc.kill()
                raise RuntimeError(f"LichtFeld training exceeded timeout ({timeout}s)")
        ret = proc.wait()
    finally:
        if proc.poll() is None:
            proc.kill()
    if ret != 0:
        raise RuntimeError(f"LichtFeld training failed (exit {ret})")


def _emit_progress(line: str, iterations: int, progress_cb):
    if progress_cb is None:
        return
    m = _STEP_RE.search(line)
    if not m:
        return
    step, total = int(m.group(1)), int(m.group(2))
    # Guard against matching unrelated "a/b" pairs: the total should look like
    # the configured iteration count (allow LichtFeld to report its own total).
    if total < 100 or step > total:
        return
    lm = _LOSS_RE.search(line)
    loss = float(lm.group(1)) if lm else 0.0
    progress_cb(step, loss)


def _find_output_ply(output_dir: Path) -> Optional[Path]:
    """Pick the trained PLY. LichtFeld writes ``splat_<iter>.ply`` (and possibly
    intermediate checkpoints), so prefer the largest iteration, newest as tiebreak."""
    plys = list(output_dir.rglob("*.ply"))
    if not plys:
        return None

    def sort_key(p: Path):
        nums = re.findall(r"(\d+)", p.stem)
        iter_n = int(nums[-1]) if nums else -1
        return (iter_n, p.stat().st_mtime)

    return max(plys, key=sort_key)
