from enum import Enum
from typing import Optional
from datetime import datetime
from pydantic import BaseModel, Field


class OutputFormat(str, Enum):
    SPLAT = "splat"
    PLY = "ply"


class JobStatus(str, Enum):
    QUEUED = "queued"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class JobConfig(BaseModel):
    output_format: OutputFormat = OutputFormat.SPLAT
    max_frames: int = Field(default=40, ge=8, le=80)
    training_iterations: int = Field(default=7000, ge=1000, le=30000)
    resolution: int = Field(default=768, ge=256, le=1920)


class StageProgress(BaseModel):
    name: str
    status: str = "pending"
    detail: Optional[str] = None


class JobResponse(BaseModel):
    job_id: str
    status: JobStatus
    message: str


class JobStatusResponse(BaseModel):
    job_id: str
    status: JobStatus
    created_at: datetime
    stages: list[StageProgress] = []
    error: Optional[str] = None
    result_format: Optional[OutputFormat] = None


class HealthResponse(BaseModel):
    status: str
    gpu_name: Optional[str] = None
    gpu_memory_total_mb: Optional[int] = None
    gpu_memory_used_mb: Optional[int] = None
    gpu_memory_free_mb: Optional[int] = None
    active_jobs: int = 0
    queued_jobs: int = 0
