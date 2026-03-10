import { useEffect, useState, type ReactNode } from 'react';
import { useAuthStore } from '../../store/authStore';

interface AuthedImageProps {
  src: string;
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
  loading?: 'lazy' | 'eager';
  onError?: () => void;
  onLoad?: () => void;
  fallback?: ReactNode;
}

export function AuthedImage({ src, alt = '', className, style, loading, onError, onLoad, fallback }: AuthedImageProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    setBlobUrl(null);
    setFailed(false);

    const load = async () => {
      const token = useAuthStore.getState().accessToken;
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      try {
        const res = await fetch(src, { headers, credentials: 'include' });
        if (cancelled) return;
        if (!res.ok) {
          setFailed(true);
          onError?.();
          return;
        }
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
        onLoad?.();
      } catch {
        if (!cancelled) {
          setFailed(true);
          onError?.();
        }
      }
    };

    load();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  if (!blobUrl) return failed ? <>{fallback}</> : <>{fallback}</>;
  return <img src={blobUrl} alt={alt} className={className} style={style} loading={loading} />;
}
