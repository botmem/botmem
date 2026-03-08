import { useEffect } from 'react';
import { useJobStore } from '../store/jobStore';

export function useJobs() {
  const store = useJobStore();

  useEffect(() => {
    store.fetchJobs();
    store.fetchLogs();
    store.fetchQueueStats();
    store.connectWs();
  }, []);

  return store;
}
