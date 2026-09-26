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

    let cancelled = false;
    // Fetch initial state
    fetchJobProgress(jobId)
      .then(value => {
        if (!cancelled) setProgress(value);
      })
      .catch(error => {
        if (!cancelled) console.error(error);
      });

    // Subscribe to SSE
    unsubRef.current = subscribeJobProgress(jobId, value => {
      if (!cancelled) setProgress(value);
    });

    return () => {
      cancelled = true;
      unsubRef.current?.();
      unsubRef.current = null;
    };
  }, [jobId]);

  return progress;
}
