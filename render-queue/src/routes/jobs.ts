import { Hono } from "hono";
import type { Env, AppVariables, JobStatusResponse, JobCreateResponse } from "../types";
import { insertJob, getJob } from "../db/queries";
import { optionalAuth } from "../middleware/jwt-auth";

const jobs = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// POST /api/v1/jobs — Accept video upload, store in R2, create D1 row
jobs.post("/", optionalAuth(), async (c) => {
  const formData = await c.req.formData();
  const video = formData.get("video");

  if (!video || typeof (video as any).stream !== "function") {
    return c.json({ error: "Missing 'video' field in form data" }, 400);
  }
  const file = video as unknown as { name: string; type: string; stream(): ReadableStream };

  // Parse optional config from form data
  const outputFormat = (formData.get("output_format") as string) || "splat";
  const maxFrames = parseInt((formData.get("max_frames") as string) || "40", 10);
  const trainingIterations = parseInt(
    (formData.get("training_iterations") as string) || "7000",
    10
  );
  const rawResolution = parseInt((formData.get("resolution") as string) || "768", 10);
  // Clamp to nearest multiple of 64
  const resolution = Math.max(256, Math.min(1920, Math.floor(rawResolution / 64) * 64));

  const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const videoKey = `jobs/${jobId}/input${getExtension(file.name)}`;

  // Store video in R2
  await c.env.ASSETS.put(videoKey, file.stream(), {
    httpMetadata: { contentType: file.type || "video/mp4" },
  });

  // Insert job row in D1
  const userId = c.get("userId") || null;
  await insertJob(c.env.DB, jobId, videoKey, {
    output_format: outputFormat,
    max_frames: maxFrames,
    training_iterations: trainingIterations,
    resolution,
  }, userId);

  const response: JobCreateResponse = {
    job_id: jobId,
    status: "queued",
    message: "Job queued for processing",
  };

  return c.json(response, 201);
});

// GET /api/v1/jobs/:id — Return job status
jobs.get("/:id", async (c) => {
  const jobId = c.req.param("id");
  const job = await getJob(c.env.DB, jobId);

  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  const response: JobStatusResponse = {
    job_id: job.id,
    status: job.status,
    created_at: job.created_at,
    stages: JSON.parse(job.stages),
    error: job.error,
    result_format: job.status === "completed" ? job.output_format : null,
  };

  return c.json(response);
});

// GET /api/v1/jobs/:id/result — Stream .splat from R2
jobs.get("/:id/result", async (c) => {
  const jobId = c.req.param("id");
  const job = await getJob(c.env.DB, jobId);

  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  if (job.status !== "completed" || !job.result_key) {
    return c.json({ error: `Job not completed (status: ${job.status})` }, 400);
  }

  const object = await c.env.ASSETS.get(job.result_key);
  if (!object) {
    return c.json({ error: "Result file not found in storage" }, 404);
  }

  const ext = job.result_key.endsWith(".ply") ? ".ply" : ".splat";
  const contentType =
    ext === ".ply" ? "application/x-ply" : "application/octet-stream";
  const filename = `output${ext}`;

  return new Response(object.body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot) : ".mp4";
}

export default jobs;
