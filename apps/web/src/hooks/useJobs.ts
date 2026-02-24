import { useEffect } from 'react';
import { useJobStore } from '../store/jobStore';

export function useJobs() {
  const store = useJobStore();

  useEffect(() => {
    store.fetchJobs();
    store.fetchLogs();
    store.fetchQueueStats();
    store.connectWs();

    // Poll for job and queue updates as fallback
    const interval = setInterval(() => {
      store.fetchJobs();
      store.fetchQueueStats();
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  return store;
}
