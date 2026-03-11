import { useEffect, useState } from 'react';
import { createWsConnection, waitForAuth, subscribeToChannel } from '../../lib/api';
import { Modal } from '../ui/Modal';

interface QrCodeAuthProps {
  open: boolean;
  onClose: () => void;
  qrData: string;
  wsChannel: string;
  onSuccess: () => void;
}

export function QrCodeAuth({ open, onClose, qrData, wsChannel, onSuccess }: QrCodeAuthProps) {
  const [currentQr, setCurrentQr] = useState(qrData);
  const [status, setStatus] = useState<'pending' | 'connecting' | 'success' | 'failed'>('pending');
  const [stepMessage, setStepMessage] = useState('');

  useEffect(() => {
    if (!open || !wsChannel) return;

    const ws = createWsConnection();

    ws.onopen = () => {
      // Auth is sent automatically by createWsConnection;
      // wait for confirmation before subscribing
      waitForAuth(ws)
        .then(() => subscribeToChannel(ws, wsChannel))
        .catch(() => ws.close());
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.event === 'auth:status') {
        const { status: newStatus, step, qrData: newQr } = data.data;
        if (newStatus) setStatus(newStatus);
        if (step) setStepMessage(step);
        if (newQr) setCurrentQr(newQr);
        if (newStatus === 'success') {
          setTimeout(() => onSuccess(), 1500);
        }
      }
    };

    return () => ws.close();
  }, [open, wsChannel]);

  return (
    <Modal open={open} onClose={onClose} title="CONNECT WHATSAPP">
      <div className="flex flex-col items-center gap-4 p-4">
        {status === 'pending' && (
          <>
            <p className="font-mono text-sm text-nb-muted text-center">
              Open WhatsApp on your phone, go to Settings &gt; Linked Devices &gt; Link a Device
            </p>
            {currentQr && (
              <img src={currentQr} alt="QR Code" className="w-64 h-64 border-3 border-nb-border" />
            )}
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-nb-lime rounded-full animate-pulse" />
              <p className="font-mono text-xs text-nb-muted">Waiting for scan...</p>
            </div>
          </>
        )}
        {status === 'connecting' && (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="w-10 h-10 border-3 border-nb-lime border-t-transparent rounded-full animate-spin" />
            <p className="font-mono text-sm text-nb-lime">{stepMessage || 'Connecting...'}</p>
            <div className="flex gap-1 mt-2">
              <div className="w-2 h-2 bg-nb-lime rounded-full" />
              <div className="w-2 h-2 bg-nb-lime rounded-full animate-pulse" />
              <div className="w-2 h-2 bg-nb-border rounded-full" />
            </div>
          </div>
        )}
        {status === 'success' && (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="w-10 h-10 border-3 border-nb-lime rounded-full flex items-center justify-center">
              <svg
                className="w-6 h-6 text-nb-lime"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={3}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="font-mono text-sm text-nb-lime">{stepMessage || 'Connected!'}</p>
          </div>
        )}
        {status === 'failed' && (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="w-10 h-10 border-3 border-nb-red flex items-center justify-center">
              <svg
                className="w-6 h-6 text-nb-red"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={3}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <p className="font-mono text-sm text-nb-red">{stepMessage || 'Connection failed'}</p>
            <p className="font-mono text-xs text-nb-muted">Please try again.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
