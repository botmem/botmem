import { Navigate } from 'react-router-dom';
import { OnboardingSteps } from '../components/auth/OnboardingSteps';
import { useAuth } from '../hooks/useAuth';
import { Logo } from '../components/ui/Logo';
import { ThemeToggle } from '../components/ui/ThemeToggle';

export function OnboardingPage() {
  const { user } = useAuth();

  if (!user) return <Navigate to="/login" replace />;
  if (user.onboarded) return <Navigate to="/dashboard" replace />;

  return (
    <div className="min-h-screen bg-nb-bg p-8">
      <div className="flex items-center justify-between mb-8">
        <Logo variant="full" height={32} />
        <ThemeToggle />
      </div>
      <div className="text-center mb-4">
        <h1 className="font-display text-4xl font-bold uppercase text-nb-text">BOTMEM SETUP</h1>
        <div className="w-16 h-1 bg-nb-pink mx-auto mt-2" />
      </div>
      <OnboardingSteps />
    </div>
  );
}
