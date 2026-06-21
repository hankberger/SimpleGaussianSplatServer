// Quick local dev server for the splat-worker benchmark page.
//
// Serves development/ (benchmark.html) AND the production renderer in
// ../web-viewer (index.html, main.js) from the SAME origin, so the benchmark
// page's "Open splat in 3D viewer" link (a relative index.html?url=...) resolves
// without copying the renderer into this folder.
//
//   npm install && npm start      # then open http://localhost:9100/

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 9100;

const devDir = __dirname;
const viewerDir = path.join(__dirname, "..", "web-viewer");

// Land on the benchmark page by default.
app.get("/", (_req, res) => res.redirect("/benchmark.html"));

// Dev pages first, then the production renderer (for index.html / main.js).
app.use(express.static(devDir, { index: false }));
app.use(express.static(viewerDir));

app.listen(PORT, () => {
  console.log(`\n  Splat worker benchmark:  http://localhost:${PORT}/benchmark.html\n`);
});
