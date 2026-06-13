import { useEffect } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export function Modal({ open, onClose, title, children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const originalOverflow = document.body.style.overflow;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 animate-[fadeIn_150ms_ease-out]"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/60 animate-[fadeIn_100ms_ease-out] cursor-default"
        onClick={onClose}
        aria-label="Close dialog"
        tabIndex={-1}
      />
      <div className="relative border-4 border-nb-border bg-nb-surface shadow-nb-lg w-full max-w-lg max-h-[90vh] overflow-y-auto animate-[slideUp_150ms_ease-out]">
        <div className="sticky top-0 z-10 flex items-center justify-between p-4 sm:p-6 pb-3 bg-nb-surface border-b-3 border-nb-border">
          <h2 className="font-display text-xl font-bold uppercase text-nb-text">{title}</h2>
          <button
            onClick={onClose}
            className="border-3 border-nb-border size-9 flex items-center justify-center font-bold text-lg hover:bg-nb-red hover:text-white transition-colors cursor-pointer text-nb-text"
            aria-label="Close"
          >
            X
          </button>
        </div>
        <div className="p-4 sm:p-6">{children}</div>
      </div>
    </div>
  );
}
