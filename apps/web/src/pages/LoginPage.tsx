import { LoginForm } from '../components/auth/LoginForm';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { LoadingScreen } from '../components/ui/LoadingScreen';
import { Logo } from '../components/ui/Logo';
import { ThemeToggle } from '../components/ui/ThemeToggle';
import { usePageMeta } from '../hooks/usePageMeta';

export function LoginPage() {
  usePageMeta({
    title: 'Sign In — Access Your Personal Memory',
    description:
      'Log in to your Botmem personal memory dashboard. Search across Gmail, Slack, WhatsApp, iMessage, photos, and locations in one place.',
    robots: 'noindex, nofollow',
  });

  const { user, isLoading } = useAuth();
  const [searchParams] = useSearchParams();
  const requestedRedirect = searchParams.get('redirect') || '';
  const redirectTo =
    requestedRedirect.startsWith('/') && !requestedRedirect.startsWith('//')
      ? requestedRedirect
      : '';

  if (isLoading) return <LoadingScreen />;
  if (user) return <Navigate to={redirectTo || (user.onboarded ? '/me' : '/onboarding')} replace />;

  return (
    <main className="min-h-screen flex flex-col md:flex-row">
      {/* Top bar: logo + theme toggle (mobile only — desktop shows logo in right panel) */}
      <div className="md:hidden flex items-center justify-between px-4 py-3 border-b-4 border-nb-border bg-nb-surface">
        <Logo variant="full" height={28} />
        <ThemeToggle />
      </div>

      <div className="flex-1 flex items-center justify-center p-6 md:p-8 bg-nb-surface">
        <LoginForm redirectTo={redirectTo || undefined} />
      </div>

      <div className="hidden md:flex relative flex-1 bg-nb-bg text-nb-text items-center justify-center p-8 border-l-4 border-nb-border">
        <div data-testid="desktop-theme-toggle" className="absolute top-4 right-4">
          <ThemeToggle variant="full" />
        </div>
        <div>
          <Logo variant="full" height={36} className="mb-8" />
          <h1 className="font-display text-7xl font-bold leading-tight">
            WELCOME
            <br />
            BACK,
            <br />
            <span className="text-nb-lime">HUMAN.</span>
          </h1>
          <div className="mt-6 w-24 h-2 bg-nb-pink" />
        </div>
      </div>
    </main>
  );
}
