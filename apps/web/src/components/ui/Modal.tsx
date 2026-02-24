import { useEffect } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export function Modal({ open, onClose, title, children }: ModalProps) {
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative border-4 border-nb-border bg-nb-surface shadow-nb-lg p-6 w-full max-w-lg mx-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-xl font-bold uppercase text-nb-text">{title}</h2>
          <button
            onClick={onClose}
            className="border-3 border-nb-border w-9 h-9 flex items-center justify-center font-bold text-lg hover:bg-nb-red hover:text-white transition-colors cursor-pointer text-nb-text"
          >
            X
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
