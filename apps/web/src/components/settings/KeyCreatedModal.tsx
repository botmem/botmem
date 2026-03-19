import { useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';

interface KeyCreatedModalProps {
  open: boolean;
  onClose: () => void;
  apiKey: string;
}

export function KeyCreatedModal({ open, onClose, apiKey }: KeyCreatedModalProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Modal open={open} onClose={onClose} title="API KEY CREATED">
      <div className="flex flex-col gap-4">
        <div className="border-3 border-nb-yellow bg-nb-surface-muted p-3">
          <p className="font-display text-sm font-bold uppercase text-nb-yellow">
            This key will only be shown once.
          </p>
          <p className="font-mono text-xs text-nb-muted mt-1">
            Copy it now and store it securely. You won't be able to see it again.
          </p>
        </div>
        <div className="border-3 border-nb-lime bg-nb-surface-muted p-3">
          <p className="font-mono text-xs text-nb-muted mb-2">YOUR API KEY</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              id="api-key-value"
              name="api-key-value"
              readOnly
              value={apiKey}
              className="flex-1 font-mono text-sm text-nb-text bg-transparent border-none outline-none select-all"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <Button size="sm" onClick={handleCopy}>
              {copied ? 'COPIED' : 'COPY'}
            </Button>
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={onClose}>DONE</Button>
        </div>
      </div>
    </Modal>
  );
}
