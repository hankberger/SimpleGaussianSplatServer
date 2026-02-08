import React, { createContext, useContext, useReducer, useEffect, useCallback } from 'react';
import { uploadVideo, getJobStatus } from '../services/api';
import { POLL_INTERVAL_MS } from '../config';

const JobContext = createContext(null);

const initialState = {
  activeJobId: null,
  jobStatus: null,
  isUploading: false,
  uploadError: null,
  uploadProgress: 0,
};

function jobReducer(state, action) {
  switch (action.type) {
    case 'UPLOAD_START':
      return { ...state, isUploading: true, uploadError: null, uploadProgress: 0 };
    case 'UPLOAD_PROGRESS':
      return { ...state, uploadProgress: action.progress };
    case 'UPLOAD_SUCCESS':
      return {
        ...state,
        isUploading: false,
        activeJobId: action.jobId,
        jobStatus: { status: 'queued', stages: [] },
        uploadProgress: 1,
      };
    case 'UPLOAD_ERROR':
      return { ...state, isUploading: false, uploadError: action.error, uploadProgress: 0 };
    case 'JOB_STATUS_UPDATE':
      return { ...state, jobStatus: action.status };
    case 'DISMISS_JOB':
      return { ...initialState };
    default:
      return state;
  }
}

export function JobProvider({ children, navigationRef }) {
  const [state, dispatch] = useReducer(jobReducer, initialState);

  const startUpload = useCallback(async (videoUri) => {
    dispatch({ type: 'UPLOAD_START' });
    try {
      const result = await uploadVideo(videoUri, (progress) => {
        dispatch({ type: 'UPLOAD_PROGRESS', progress });
      });
      dispatch({ type: 'UPLOAD_SUCCESS', jobId: result.job_id });
      // Navigate to Viewer tab
      if (navigationRef?.current) {
        navigationRef.current.navigate('Viewer');
      }
    } catch (err) {
      dispatch({ type: 'UPLOAD_ERROR', error: err.message });
    }
  }, [navigationRef]);

  const dismissJob = useCallback(() => {
    dispatch({ type: 'DISMISS_JOB' });
  }, []);

  // Poll job status
  useEffect(() => {
    if (!state.activeJobId) return;
    if (state.jobStatus?.status === 'completed' || state.jobStatus?.status === 'failed') return;

    const interval = setInterval(async () => {
      try {
        const status = await getJobStatus(state.activeJobId);
        dispatch({ type: 'JOB_STATUS_UPDATE', status });
      } catch (err) {
        // Silently ignore poll errors — will retry next interval
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [state.activeJobId, state.jobStatus?.status]);

  return (
    <JobContext.Provider value={{ ...state, startUpload, dismissJob }}>
      {children}
    </JobContext.Provider>
  );
}

export function useJob() {
  const context = useContext(JobContext);
  if (!context) throw new Error('useJob must be used within a JobProvider');
  return context;
}
