# Development tools

Local-only dev tooling. **Not** part of the production app — keep production
viewer code in `web-viewer/`.

## Benchmark viewer

`benchmark.html` uploads a video straight to the worker, polls and times each
pipeline stage, shows the rendered preview, and opens the finished splat in the
3D renderer.

### Run it

1. Start the worker (separate terminal):
   ```bash
   conda activate splatapp
   uvicorn worker.app:app --host 0.0.0.0 --port 8000
   ```
2. Start this dev server:
   ```bash
   cd development
   npm install
   npm start
   ```
3. Open <http://localhost:9100/benchmark.html>.

The server also serves the `../web-viewer` renderer at the same origin, so the
"Open splat in 3D viewer" button works. Override the port with `PORT=xxxx npm start`.
The worker URL (default `http://localhost:8000`) is editable in the page and
persisted in localStorage.
