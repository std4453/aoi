import { resourceUrl } from '../lib/connection';
import { get } from './client';
import type { JobProgress } from '../../../shared/types.js';

export function fetchJobProgress(jobId: string): Promise<JobProgress> {
  return get<JobProgress>(`/jobs/${jobId}`);
}

export function subscribeJobProgress(jobId: string, onProgress: (progress: JobProgress) => void): () => void {
  const eventSource = new EventSource(resourceUrl(`/api/jobs/${jobId}/events`));
  let poll: ReturnType<typeof setInterval> | null = null;

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
    if (poll) return;
    poll = setInterval(async () => {
      try {
        const data = await fetchJobProgress(jobId);
        onProgress(data);
        if (data.status === 'completed' || data.status === 'failed') {
          if (poll) clearInterval(poll);
          poll = null;
        }
      } catch {
        if (poll) clearInterval(poll);
        poll = null;
      }
    }, 2000);
  };

  return () => {
    eventSource.close();
    if (poll) clearInterval(poll);
    poll = null;
  };
}
