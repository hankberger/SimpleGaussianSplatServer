export interface Env {
  ASSETS: R2Bucket;
  DB: D1Database;
  WORKER_API_KEY: string;
  R2_PUBLIC_URL: string;
  JWT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  APPLE_BUNDLE_ID: string;
}

export interface AppVariables {
  userId: string;
  userEmail: string;
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
  user_id: string | null;
}

export interface PostRow {
  id: string;
  user_id: string | null;
  result_key: string;
  output_format: string;
  title: string | null;
  description: string | null;
  view_count: number;
  like_count: number;
  comment_count: number;
  created_at: string;
  updated_at: string;
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
  post_id: string;
  job_id: string; // backward compat (same value as post_id)
  user_id: string | null;
  display_name: string | null;
  title: string | null;
  description: string | null;
  created_at: string;
  view_count: number;
  like_count: number;
  comment_count: number;
  splat_url: string;
  liked_by_me: boolean;
}

export interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  salt: string | null;
  provider: string;
  provider_id: string | null;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface LikeRow {
  user_id: string;
  job_id: string;
  post_id: string | null;
  created_at: string;
}

export interface AuthPayload {
  sub: string;
  email: string;
  exp: number;
}

export interface RegisterRequest {
  email: string;
  password: string;
  display_name?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface OAuthRequest {
  provider: "google" | "apple";
  id_token: string;
  display_name?: string;
}

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    email: string;
    display_name: string | null;
    provider: string;
  };
}

export interface FeedResponse {
  items: FeedItem[];
  total: number;
  offset: number;
  limit: number;
}

export interface CommentRow {
  id: string;
  post_id: string;
  user_id: string;
  parent_id: string | null;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface CommentItem {
  id: string;
  post_id: string;
  user_id: string;
  parent_id: string | null;
  display_name: string | null;
  body: string;
  created_at: string;
  replies: CommentItem[];
  reply_count: number;
}

export interface CommentsResponse {
  comments: CommentItem[];
  total: number;
  offset: number;
  limit: number;
}
