import { useEffect, useState } from 'react';
import { createWsConnection, subscribeToChannel } from '../../lib/api';
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
  const [status, setStatus] = useState<'pending' | 'success' | 'failed'>('pending');

  useEffect(() => {
    if (!open || !wsChannel) return;

    const ws = createWsConnection();

    ws.onopen = () => {
      subscribeToChannel(ws, wsChannel);
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.event === 'auth:status') {
        setStatus(data.data.status);
        if (data.data.qrData) setCurrentQr(data.data.qrData);
        if (data.data.status === 'success') {
          onSuccess();
        }
      }
    };

    return () => ws.close();
  }, [open, wsChannel]);

  return (
    <Modal open={open} onClose={onClose} title="SCAN QR CODE">
      <div className="flex flex-col items-center gap-4 p-4">
        {status === 'pending' && (
          <>
            <p className="font-mono text-sm text-nb-muted text-center">
              Open WhatsApp on your phone, go to Settings &gt; Linked Devices &gt; Link a Device
            </p>
            {currentQr && (
              <img
                src={currentQr}
                alt="QR Code"
                className="w-64 h-64 border-3 border-nb-border"
              />
            )}
            <p className="font-mono text-xs text-nb-muted animate-pulse">Waiting for scan...</p>
          </>
        )}
        {status === 'success' && (
          <p className="font-mono text-sm text-nb-green">Connected successfully!</p>
        )}
        {status === 'failed' && (
          <p className="font-mono text-sm text-nb-red">Connection failed. Please try again.</p>
        )}
      </div>
    </Modal>
  );
}
