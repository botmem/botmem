import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AuthedImage } from './AuthedImage';

interface ImageLightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/80"
      style={{ zIndex: 9999 }}
      onClick={onClose}
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
      >
        <AuthedImage src={src} alt={alt} className="max-w-full max-h-[90vh] object-contain" />
      </div>
    </div>,
    document.body,
  );
}
