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
const MAX_IMAGE_FETCHES = 4;
let activeImageFetches = 0;
const imageQueue: Array<() => void> = [];

function runQueuedImageFetch<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeImageFetches++;
      task()
        .then(resolve, reject)
        .finally(() => {
          activeImageFetches--;
          imageQueue.shift()?.();
        });
    };
    if (activeImageFetches < MAX_IMAGE_FETCHES) run();
    else imageQueue.push(run);
  });
}

function retryDelay(ms: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function fetchImage(src: string, init: RequestInit): Promise<Response> {
  let res = await fetch(src, init);
  if (res.status !== 503) return res;
  await retryDelay(250);
  res = await fetch(src, init);
  return res;
}

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
      const controller = abortCtrl;
      const token = useAuthStore.getState().accessToken;
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      runQueuedImageFetch(() =>
        fetchImage(src, { headers, credentials: 'include', signal: controller.signal }),
      )
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
