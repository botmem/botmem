import { SignupForm } from '../components/auth/SignupForm';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export function SignupPage() {
  const { user } = useAuth();
  if (user) return <Navigate to="/dashboard" replace />;

  return (
    <div className="min-h-screen flex">
      <div className="flex-1 flex items-center justify-center p-8 bg-nb-surface">
        <SignupForm />
      </div>
      <div className="flex-1 bg-nb-bg text-white flex items-center justify-center p-8 border-l-4 border-nb-border">
        <div>
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
        </div>
      </div>
    </div>
  );
}
