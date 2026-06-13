import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { safeAuthReturnTo } from '../../store/authStore';

interface AuthGuardProps {
  children: React.ReactNode;
  requireOnboarded?: boolean;
}

export function AuthGuard({ children, requireOnboarded }: AuthGuardProps) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-nb-bg">
        <div className="font-mono text-sm text-nb-text">Loading...</div>
      </div>
    );
  }

  if (!user) {
    const returnTo = safeAuthReturnTo(`${location.pathname}${location.search}${location.hash}`);
    return (
      <Navigate
        to={returnTo ? `/login?redirect=${encodeURIComponent(returnTo)}` : '/login'}
        replace
      />
    );
  }

  if (requireOnboarded && !user.onboarded) {
    return <Navigate to="/onboarding" replace />;
  }

  return <>{children}</>;
}
