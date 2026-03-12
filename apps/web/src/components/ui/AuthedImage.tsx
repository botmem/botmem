import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useAuthStore } from '../../store/authStore';

interface AuthedImageProps {
  src: string;
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
  loading?: 'lazy' | 'eager';
  onError?: () => void;
  onLoad?: () => void;
  fallback?: React.ReactNode;
}

type BlobState = { url: string | null; failed: boolean };
const EMPTY: BlobState = { url: null, failed: false };

function createBlobStore() {
  let state: BlobState = EMPTY;
  let currentSrc = '';
  let abortCtrl: AbortController | null = null;
  const listeners = new Set<() => void>();

  function notify() {
    listeners.forEach((l) => l());
  }

  return {
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getSnapshot() {
      return state;
    },
    load(src: string, onError?: () => void, onLoad?: () => void) {
      if (src === currentSrc) return;
      abortCtrl?.abort();
      if (state.url) URL.revokeObjectURL(state.url);
      currentSrc = src;
      state = EMPTY;
      notify();

      abortCtrl = new AbortController();
      const token = useAuthStore.getState().accessToken;
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      fetch(src, { headers, credentials: 'include', signal: abortCtrl.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          state = { url: URL.createObjectURL(blob), failed: false };
          onLoad?.();
          notify();
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          state = { url: null, failed: true };
          onError?.();
          notify();
        });
    },
    cleanup() {
      abortCtrl?.abort();
      if (state.url) URL.revokeObjectURL(state.url);
      currentSrc = '';
      state = EMPTY;
    },
  };
}

export function AuthedImage({
  src,
  alt = '',
  className,
  style,
  loading,
  onError,
  onLoad,
  fallback,
}: AuthedImageProps) {
  const storeRef = useRef<ReturnType<typeof createBlobStore>>(null);
  if (!storeRef.current) storeRef.current = createBlobStore();
  const store = storeRef.current;

  useEffect(() => {
    store.load(src, onError, onLoad);
  }, [store, src, onError, onLoad]);

  useEffect(() => {
    return () => store.cleanup();
  }, [store]);

  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
  const { url, failed } = useSyncExternalStore(subscribe, () => store.getSnapshot());

  if (!url || failed) return <>{fallback}</>;
  return <img src={url} alt={alt} className={className} style={style} loading={loading} />;
}
