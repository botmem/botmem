import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';

export function OAuthRedirect() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'processing' | 'success' | 'error'>('processing');

  const authStatus = searchParams.get('auth');
  const connectorType = searchParams.get('type');

  useEffect(() => {
    if (authStatus === 'success') {
      setStatus('success');
      setTimeout(() => navigate('/connectors'), 2000);
    } else if (authStatus === 'error') {
      setStatus('error');
    }
  }, [authStatus]);

  if (status === 'processing') {
    return (
      <div className="flex items-center justify-center min-h-screen bg-nb-bg">
        <p className="font-mono text-nb-muted animate-pulse">Processing authentication...</p>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div className="flex items-center justify-center min-h-screen bg-nb-bg">
        <div className="text-center">
          <p className="font-mono text-nb-green text-lg mb-2">
            {connectorType?.toUpperCase()} connected!
          </p>
          <p className="font-mono text-sm text-nb-muted">Redirecting...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-nb-bg">
      <p className="font-mono text-nb-red">Authentication failed. Please try again.</p>
    </div>
  );
}
