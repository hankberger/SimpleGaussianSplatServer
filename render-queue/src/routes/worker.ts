import { Hono } from "hono";
import type { Env, StageProgress } from "../types";
import { workerAuth } from "../middleware/auth";
import { claimOldestJob, getJob, updateJobStatus, setJobResultKey } from "../db/queries";

const worker = new Hono<{ Bindings: Env }>();

// All worker routes require API key auth
worker.use("/*", workerAuth);

// POST /api/v1/worker/claim — Atomically claim the oldest queued job
worker.post("/claim", async (c) => {
  const job = await claimOldestJob(c.env.DB);

  if (!job) {
    return c.json({ job: null }, 200);
  }

  return c.json({
    job: {
      id: job.id,
      config: {
        output_format: job.output_format,
        max_frames: job.max_frames,
        training_iterations: job.training_iterations,
        resolution: job.resolution,
      },
    },
  });
});

// GET /api/v1/worker/jobs/:id/video — Stream video from R2
worker.get("/jobs/:id/video", async (c) => {
  const jobId = c.req.param("id");
  const job = await getJob(c.env.DB, jobId);

  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  if (!job.video_key) {
    return c.json({ error: "No video associated with this job" }, 400);
  }

  const object = await c.env.ASSETS.get(job.video_key);
  if (!object) {
    return c.json({ error: "Video not found in storage" }, 404);
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "video/mp4",
    },
  });
});

// PUT /api/v1/worker/jobs/:id/status — Update job status and stages
worker.put("/jobs/:id/status", async (c) => {
  const jobId = c.req.param("id");
  const body = await c.req.json<{
    status: string;
    stages?: StageProgress[];
    error?: string;
  }>();

  const validStatuses = ["processing", "completed", "failed"];
  if (!validStatuses.includes(body.status)) {
    return c.json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` }, 400);
  }

  const updated = await updateJobStatus(
    c.env.DB,
    jobId,
    body.status as any,
    body.stages,
    body.error
  );

  if (!updated) {
    return c.json({ error: "Job not found" }, 404);
  }

  return c.json({ ok: true });
});

// PUT /api/v1/worker/jobs/:id/result — Upload .splat result to R2
worker.put("/jobs/:id/result", async (c) => {
  const jobId = c.req.param("id");
  const job = await getJob(c.env.DB, jobId);

  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  const ext = job.output_format === "ply" ? ".ply" : ".splat";
  const resultKey = `jobs/${jobId}/output${ext}`;

  // Stream the request body directly to R2
  await c.env.ASSETS.put(resultKey, c.req.raw.body, {
    httpMetadata: {
      contentType:
        ext === ".ply" ? "application/x-ply" : "application/octet-stream",
    },
  });

  // Mark job as completed with result key
  await setJobResultKey(c.env.DB, jobId, resultKey);

  return c.json({ ok: true, result_key: resultKey });
});

export default worker;
