import { useState } from 'react';
import { Modal } from './Modal';
import { useAuthStore } from '../../store/authStore';

export function RecoveryKeyModal() {
  const recoveryKey = useAuthStore((s) => s.recoveryKey);
  const dismissRecoveryKey = useAuthStore((s) => s.dismissRecoveryKey);
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  if (!recoveryKey) return null;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(recoveryKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Modal open={true} onClose={() => {}} title="Save Your Recovery Key">
      <div className="flex flex-col gap-4">
        <p className="font-mono text-sm text-nb-red font-bold">
          This is your encryption key. Without it, your data CANNOT be recovered. Not by us, not by
          anyone. Save it now.
        </p>

        <div className="relative">
          <pre
            data-ph-mask
            className="w-full p-4 border-3 border-nb-border bg-nb-surface font-mono text-base text-nb-text break-all whitespace-pre-wrap select-all"
          >
            {recoveryKey}
          </pre>
          <button
            onClick={handleCopy}
            className="absolute top-2 right-2 px-3 py-1 border-2 border-nb-border bg-nb-bg font-mono text-xs text-nb-muted hover:text-nb-text hover:border-nb-lime cursor-pointer transition-colors"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-1 accent-[#C4F53A] size-4"
          />
          <span className="font-mono text-sm text-nb-muted">
            I have saved my recovery key in a safe place
          </span>
        </label>

        <button
          onClick={dismissRecoveryKey}
          disabled={!confirmed}
          className="w-full py-3 border-3 border-nb-lime bg-nb-lime font-display text-sm font-bold uppercase tracking-wider text-black hover:bg-nb-lime/80 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          Continue
        </button>
      </div>
    </Modal>
  );
}
