import { useCallback } from 'react';
import { createPortal } from 'react-dom';
import { AuthedImage } from './AuthedImage';

interface ImageLightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') onClose();
    },
    [onClose],
  );

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt || 'Image lightbox'}
      className="fixed inset-0 flex items-center justify-center bg-black/80"
      style={{ zIndex: 9999 }}
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 border-2 border-white/40 size-10 flex items-center justify-center font-bold text-white hover:bg-white/20 transition-colors cursor-pointer"
        aria-label="Close lightbox"
      >
        X
      </button>
      <div
        className="max-w-[90vw] max-h-[90vh] flex items-center justify-center"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="img"
        aria-label={alt || 'Image preview'}
      >
        <AuthedImage src={src} alt={alt} className="max-w-full max-h-[90vh] object-contain" />
      </div>
    </div>,
    document.body,
  );
}
