import { useSyncExternalStore } from 'react';
import { getConnectionState, subscribeConnection } from '../lib/connection';

export function useConnectionState() {
  return useSyncExternalStore(subscribeConnection, getConnectionState);
}
