const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 9000;

const jobsDir = path.join(__dirname, "..", "jobs");

// API endpoint to list available splat files
app.get("/api/splats", (req, res) => {
  fs.readdir(jobsDir, { withFileTypes: true }, (err, entries) => {
    if (err) {
      return res.status(500).json({ error: "Failed to read jobs directory" });
    }
    const splats = [];
    let pending = 0;
    const dirs = entries.filter((e) => e.isDirectory());
    if (dirs.length === 0) return res.json([]);
    for (const dir of dirs) {
      pending++;
      const dirPath = path.join(jobsDir, dir.name);
      fs.readdir(dirPath, (err, files) => {
        if (!err && files) {
          for (const file of files) {
            if (file.endsWith(".splat")) {
              splats.push({
                name: dir.name,
                url: `/jobs/${dir.name}/${file}`,
              });
            }
          }
        }
        if (--pending === 0) {
          splats.sort((a, b) => a.name.localeCompare(b.name));
          res.json(splats);
        }
      });
    }
  });
});

// Serve static files from the renderer directory (index.html, main.js, etc.)
app.use(express.static(__dirname));

// Serve /jobs as a static directory
app.use("/jobs", express.static(path.join(__dirname, "..", "jobs")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
