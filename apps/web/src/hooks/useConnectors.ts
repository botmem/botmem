import { useEffect } from 'react';
import { useConnectorStore } from '../store/connectorStore';

export function useConnectors() {
  const store = useConnectorStore();

  useEffect(() => {
    store.fetchManifests();
    store.fetchAccounts();
  }, []);

  return store;
}
