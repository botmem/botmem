import { Modal } from '../ui/Modal';
import { useNavigate } from 'react-router-dom';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SubscribeCTA({ open, onClose }: Props) {
  const navigate = useNavigate();

  const features = [
    'Unlimited memories across all sources',
    'Priority processing & enrichment',
    'Full API & MCP server access',
    'Advanced analytics & insights',
    'Custom memory banks & organization',
  ];

  return (
    <Modal open={open} onClose={onClose} title="Unlock the Full Experience">
      <div className="space-y-4">
        <p className="font-mono text-sm text-nb-muted">
          You've seen what Botmem can do. Upgrade to unlock everything:
        </p>

        <ul className="space-y-2">
          {features.map((feature) => (
            <li key={feature} className="flex items-center gap-3">
              <span className="flex-shrink-0 w-5 h-5 border-2 border-nb-lime bg-nb-lime/20 flex items-center justify-center">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path
                    d="M2 6L5 9L10 3"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="text-nb-lime"
                  />
                </svg>
              </span>
              <span className="font-mono text-sm text-nb-text">{feature}</span>
            </li>
          ))}
        </ul>

        <div className="flex gap-3 mt-6">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 border-2 border-nb-border bg-nb-surface font-mono text-sm text-nb-muted hover:text-nb-text cursor-pointer transition-colors"
          >
            Maybe Later
          </button>
          <button
            onClick={() => {
              onClose();
              navigate('/pricing');
            }}
            className="flex-1 px-4 py-2 border-3 border-nb-border bg-nb-lime font-display text-sm font-bold uppercase shadow-nb hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none cursor-pointer transition-all"
          >
            View Plans
          </button>
        </div>
      </div>
    </Modal>
  );
}
