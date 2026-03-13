import { useCallback } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export function Modal({ open, onClose, title, children }: ModalProps) {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center animate-[fadeIn_150ms_ease-out]"
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/60 animate-[fadeIn_100ms_ease-out] cursor-default"
        onClick={onClose}
        aria-label="Close dialog"
        tabIndex={-1}
      />
      <div className="relative border-4 border-nb-border bg-nb-surface shadow-nb-lg p-4 sm:p-6 w-full max-w-lg mx-2 sm:mx-4 animate-[slideUp_150ms_ease-out]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-xl font-bold uppercase text-nb-text">{title}</h2>
          <button
            onClick={onClose}
            className="border-3 border-nb-border size-9 flex items-center justify-center font-bold text-lg hover:bg-nb-red hover:text-white transition-colors cursor-pointer text-nb-text"
            aria-label="Close"
          >
            X
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
