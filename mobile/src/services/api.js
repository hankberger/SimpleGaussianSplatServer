import { API_BASE } from '../config';

export function uploadVideo(videoUri, onProgress) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    const filename = videoUri.split('/').pop() || 'video.mp4';
    formData.append('video', {
      uri: videoUri,
      name: filename,
      type: 'video/mp4',
    });

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/api/v1/jobs`);
    // Do NOT set Content-Type — XMLHttpRequest sets the multipart boundary automatically

    xhr.timeout = 5 * 60 * 1000; // 5 minutes

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded / event.total);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error('Invalid JSON response from server'));
        }
      } else {
        reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText}`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error — is the server running?'));
    xhr.ontimeout = () => reject(new Error('Upload timed out after 5 minutes'));

    xhr.send(formData);
  });
}

export async function getJobStatus(jobId) {
  const response = await fetch(`${API_BASE}/api/v1/jobs/${jobId}`);
  if (!response.ok) {
    throw new Error(`Failed to get job status (${response.status})`);
  }
  return response.json();
}

export async function checkHealth() {
  const response = await fetch(`${API_BASE}/api/v1/health`);
  if (!response.ok) {
    throw new Error(`Health check failed (${response.status})`);
  }
  return response.json();
}
