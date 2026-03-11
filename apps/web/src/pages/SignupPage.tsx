import { SignupForm } from '../components/auth/SignupForm';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { Logo } from '../components/ui/Logo';
import { ThemeToggle } from '../components/ui/ThemeToggle';
import { usePageMeta } from '../hooks/usePageMeta';

export function SignupPage() {
  usePageMeta({
    title: 'Sign Up — Create Your Personal Memory',
    description:
      'Create a free Botmem account. Connect Gmail, Slack, WhatsApp, iMessage, photos, and locations into one searchable AI-powered personal memory. Open source, self-hosted, privacy-first.',
  });

  const { user } = useAuth();
  if (user) return <Navigate to="/dashboard" replace />;

  return (
    <main className="min-h-screen flex flex-col md:flex-row">
      {/* Top bar: logo + theme toggle (mobile only) */}
      <div className="md:hidden flex items-center justify-between px-4 py-3 border-b-4 border-nb-border bg-nb-surface">
        <Logo variant="full" height={28} />
        <ThemeToggle />
      </div>

      <div className="flex-1 flex items-center justify-center p-6 md:p-8 bg-nb-surface">
        <SignupForm />
      </div>

      <div className="hidden md:flex flex-1 bg-nb-bg text-nb-text items-center justify-center p-8 border-l-4 border-nb-border">
        <div>
          <Logo variant="full" height={36} className="mb-8" />
          <h1 className="font-display text-7xl font-bold leading-tight">
            YOUR
            <br />
            MEMORY.
            <br />
            YOUR
            <br />
            <span className="text-nb-lime">RULES.</span>
          </h1>
          <div className="mt-6 w-24 h-2 bg-nb-pink" />
          <div className="mt-6">
            <ThemeToggle variant="full" />
          </div>
        </div>
      </div>
    </main>
  );
}
