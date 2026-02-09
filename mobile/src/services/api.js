import { API_BASE } from '../config';

let _authToken = null;

export function setAuthToken(token) {
  _authToken = token;
}

function authHeaders() {
  if (!_authToken) return {};
  return { Authorization: `Bearer ${_authToken}` };
}

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

    // Set auth header if available
    if (_authToken) {
      xhr.setRequestHeader('Authorization', `Bearer ${_authToken}`);
    }

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
  const response = await fetch(`${API_BASE}/api/v1/jobs/${jobId}`, {
    headers: authHeaders(),
  });
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

export async function getFeed(limit = 10, offset = 0) {
  const response = await fetch(`${API_BASE}/api/v1/feed?limit=${limit}&offset=${offset}`, {
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Failed to load feed (${response.status})`);
  }
  return response.json();
}

export async function getMyPosts(limit = 30, offset = 0) {
  const response = await fetch(`${API_BASE}/api/v1/feed/me?limit=${limit}&offset=${offset}`, {
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Failed to load posts (${response.status})`);
  }
  return response.json();
}

export async function trackView(postId) {
  // Fire-and-forget — don't await or throw on failure
  fetch(`${API_BASE}/api/v1/feed/${postId}/view`, {
    method: 'POST',
    headers: authHeaders(),
  }).catch(() => {});
}

export async function likeSplat(postId) {
  const response = await fetch(`${API_BASE}/api/v1/feed/${postId}/like`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Like failed (${response.status})`);
  }
  return response.json();
}

export async function unlikeSplat(postId) {
  const response = await fetch(`${API_BASE}/api/v1/feed/${postId}/like`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Unlike failed (${response.status})`);
  }
  return response.json();
}

// Auth API functions

export async function registerUser(email, password, displayName) {
  const response = await fetch(`${API_BASE}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, display_name: displayName || undefined }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Registration failed (${response.status})`);
  }
  return data;
}

export async function loginUser(email, password) {
  const response = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Login failed (${response.status})`);
  }
  return data;
}

export async function oauthLogin(provider, idToken, displayName) {
  const response = await fetch(`${API_BASE}/api/v1/auth/oauth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, id_token: idToken, display_name: displayName || undefined }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `OAuth failed (${response.status})`);
  }
  return data;
}

export async function getMe() {
  const response = await fetch(`${API_BASE}/api/v1/auth/me`, {
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Failed to get user (${response.status})`);
  }
  return response.json();
}

// Comments API functions

export async function getComments(postId, limit = 20, offset = 0) {
  const response = await fetch(
    `${API_BASE}/api/v1/feed/${postId}/comments?limit=${limit}&offset=${offset}`,
    { headers: authHeaders() }
  );
  if (!response.ok) {
    throw new Error(`Failed to load comments (${response.status})`);
  }
  return response.json();
}

export async function postComment(postId, body, parentId) {
  const payload = { body };
  if (parentId) payload.parent_id = parentId;

  const response = await fetch(`${API_BASE}/api/v1/feed/${postId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Failed to post comment (${response.status})`);
  }
  return response.json();
}

export async function deleteComment(postId, commentId) {
  const response = await fetch(`${API_BASE}/api/v1/feed/${postId}/comments/${commentId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Failed to delete comment (${response.status})`);
  }
  return response.json();
}
