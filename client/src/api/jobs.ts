import { get } from './client';
import type { JobProgress } from '../../../shared/types.js';

export function fetchJobProgress(jobId: string): Promise<JobProgress> {
  return get<JobProgress>(`/jobs/${jobId}`);
}

export function subscribeJobProgress(jobId: string, onProgress: (progress: JobProgress) => void): () => void {
  const eventSource = new EventSource(`/api/jobs/${jobId}/events`);

  eventSource.onmessage = (event) => {
    const data: JobProgress = JSON.parse(event.data);
    onProgress(data);
    if (data.status === 'completed' || data.status === 'failed') {
      eventSource.close();
    }
  };

  eventSource.onerror = () => {
    eventSource.close();
    // Fall back to polling
    const poll = setInterval(async () => {
      try {
        const data = await fetchJobProgress(jobId);
        onProgress(data);
        if (data.status === 'completed' || data.status === 'failed') {
          clearInterval(poll);
        }
      } catch {
        clearInterval(poll);
      }
    }, 2000);
  };

  return () => eventSource.close();
}
