// Quick local dev server for the splat-worker benchmark page.
//
// Serves development/ (benchmark.html) AND the production renderer in
// ../web-viewer (index.html, main.js) from the SAME origin, so the benchmark
// page's "Open splat in 3D viewer" link (a relative index.html?url=...) resolves
// without copying the renderer into this folder.
//
// Also persists benchmark history server-side (benchmark-data.json) via a small
// JSON API, so results survive browser/device changes instead of living only in
// each browser's localStorage.
//
//   npm install && npm start      # then open http://localhost:9100/

const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 9100;

const devDir = __dirname;
const viewerDir = path.join(__dirname, "..", "web-viewer");
const DATA_FILE = path.join(devDir, "benchmark-data.json");
const MAX_RECORDS = 200;

app.use(express.json({ limit: "1mb" }));

// --- Benchmark history store (durable JSON file on disk) ---
function readBenchmarks() {
  try {
    const records = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return Array.isArray(records) ? records : [];
  } catch {
    return []; // missing or corrupt file -> start empty
  }
}

function writeBenchmarks(records) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(records, null, 2));
}

// Records are stored newest-first; the client renders them in array order.
app.get("/api/benchmark", (_req, res) => {
  res.json(readBenchmarks());
});

app.post("/api/benchmark", (req, res) => {
  if (!req.body || typeof req.body !== "object") {
    return res.status(400).json({ error: "expected a benchmark record object" });
  }
  const records = readBenchmarks();
  records.unshift(req.body);
  const trimmed = records.slice(0, MAX_RECORDS);
  try {
    writeBenchmarks(trimmed);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
  res.json(trimmed); // return the updated list so the client can re-render
});

app.delete("/api/benchmark", (_req, res) => {
  try {
    writeBenchmarks([]);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
  res.json([]);
});

// Land on the benchmark page by default.
app.get("/", (_req, res) => res.redirect("/benchmark.html"));

// Dev pages first, then the production renderer (for index.html / main.js).
app.use(express.static(devDir, { index: false }));
app.use(express.static(viewerDir));

app.listen(PORT, () => {
  console.log(`\n  Splat worker benchmark:  http://localhost:${PORT}/benchmark.html\n`);
});
