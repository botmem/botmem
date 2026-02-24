import { Navigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';

interface AuthGuardProps {
  children: React.ReactNode;
  requireOnboarded?: boolean;
}

export function AuthGuard({ children, requireOnboarded }: AuthGuardProps) {
  const { user } = useAuth();

  if (!user) return <Navigate to="/login" replace />;

  if (requireOnboarded && !user.onboarded) {
    return <Navigate to="/onboarding" replace />;
  }

  return <>{children}</>;
}
