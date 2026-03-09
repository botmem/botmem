import { useEffect, useState } from 'react';
import { useAuthStore } from '../../store/authStore';

interface AuthedImageProps {
  src: string;
  alt?: string;
  className?: string;
  loading?: 'lazy' | 'eager';
}

export function AuthedImage({ src, alt = '', className, loading }: AuthedImageProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;

    const load = async () => {
      const token = useAuthStore.getState().accessToken;
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      try {
        const res = await fetch(src, { headers, credentials: 'include' });
        if (cancelled || !res.ok) return;
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      } catch {
        // silently ignore — image just won't display
      }
    };

    load();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  if (!blobUrl) return null;
  return <img src={blobUrl} alt={alt} className={className} loading={loading} />;
}
