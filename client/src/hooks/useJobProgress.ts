import { useState, useEffect, useRef } from 'react';
import { subscribeJobProgress, fetchJobProgress } from '../api/jobs';
import type { JobProgress } from '../../../shared/types.js';

export function useJobProgress(jobId: string | null) {
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!jobId) {
      setProgress(null);
      return;
    }

    // Fetch initial state
    fetchJobProgress(jobId).then(setProgress).catch(console.error);

    // Subscribe to SSE
    unsubRef.current = subscribeJobProgress(jobId, setProgress);

    return () => {
      unsubRef.current?.();
    };
  }, [jobId]);

  return progress;
}
