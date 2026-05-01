import { Logo } from './Logo';

export function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-nb-bg">
      <div className="text-center">
        <Logo variant="full" height={40} className="mx-auto mb-4" />
        <div className="font-mono text-sm text-nb-muted">Loading...</div>
      </div>
    </div>
  );
}
