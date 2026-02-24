import { LoginForm } from '../components/auth/LoginForm';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export function LoginPage() {
  const { user } = useAuth();
  if (user) return <Navigate to="/dashboard" replace />;

  return (
    <div className="min-h-screen flex">
      <div className="flex-1 flex items-center justify-center p-8 bg-nb-surface">
        <LoginForm />
      </div>
      <div className="flex-1 bg-nb-bg text-white flex items-center justify-center p-8 border-l-4 border-nb-border">
        <div>
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
    </div>
  );
}
