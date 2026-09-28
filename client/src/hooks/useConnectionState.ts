import { useSyncExternalStore } from 'react';
import { CONNECTION_EVENT, connectionState } from '../lib/connection';

function subscribe(callback: () => void): () => void {
  window.addEventListener(CONNECTION_EVENT, callback);
  return () => window.removeEventListener(CONNECTION_EVENT, callback);
}
export function useConnectionState() {
  return useSyncExternalStore(subscribe, () => connectionState);
}
