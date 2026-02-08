export interface Env {
  ASSETS: R2Bucket;
  DB: D1Database;
  WORKER_API_KEY: string;
  R2_PUBLIC_URL: string;
}

export type JobStatus = "queued" | "claimed" | "processing" | "completed" | "failed";

export interface StageProgress {
  name: string;
  status: "pending" | "running" | "completed" | "failed";
  detail?: string;
}

export interface JobRow {
  id: string;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  output_format: string;
  max_frames: number;
  training_iterations: number;
  resolution: number;
  video_key: string | null;
  result_key: string | null;
  stages: string; // JSON array of StageProgress
  error: string | null;
  view_count: number;
  like_count: number;
}

export interface JobConfig {
  output_format: string;
  max_frames: number;
  training_iterations: number;
  resolution: number;
}

export interface JobStatusResponse {
  job_id: string;
  status: JobStatus;
  created_at: string;
  stages: StageProgress[];
  error: string | null;
  result_format: string | null;
}

export interface JobCreateResponse {
  job_id: string;
  status: JobStatus;
  message: string;
}

export interface FeedItem {
  job_id: string;
  created_at: string;
  view_count: number;
  like_count: number;
  splat_url: string;
}

export interface FeedResponse {
  items: FeedItem[];
  total: number;
  offset: number;
  limit: number;
}
