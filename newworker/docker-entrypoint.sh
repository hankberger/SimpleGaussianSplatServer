#!/bin/bash
# Container entrypoint. LichtFeld Studio links GTK/X11 even in --headless mode,
# so we bring up a virtual X display (Xvfb) to satisfy any GUI init. This is
# harmless for the CUDA/Vulkan offscreen training path and removes a whole class
# of "cannot open display" failures.
set -e

# Make the bundled trainer executable (host checkouts can lose the +x bit).
chmod +x /app/newworker/bin/run_lichtfeld.sh /app/newworker/bin/LichtFeld-Studio 2>/dev/null || true

if [ -z "${DISPLAY:-}" ]; then
    Xvfb :99 -screen 0 1280x720x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
    export DISPLAY=:99
    for _ in $(seq 1 30); do
        [ -S /tmp/.X11-unix/X99 ] && break
        sleep 0.1
    done
fi

exec "$@"
