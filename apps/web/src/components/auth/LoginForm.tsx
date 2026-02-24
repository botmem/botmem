import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { useAuth } from '../../hooks/useAuth';

export function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const ok = login(email, password);
    if (ok) {
      navigate('/dashboard');
    } else {
      setError('No account found. Sign up first.');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5 w-full max-w-sm">
      <h2 className="font-display text-3xl font-bold uppercase text-nb-text">Sign In</h2>

      {error && (
        <div className="border-3 border-nb-red bg-nb-red/10 p-3 font-mono text-sm text-nb-red font-bold">
          {error}
        </div>
      )}

      <Input
        label="Email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="your@email.com"
        required
      />
      <Input
        label="Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="••••••••"
        required
      />

      <Button type="submit" size="lg">
        SIGN IN
      </Button>

      <p className="font-mono text-sm text-nb-text">
        No account?{' '}
        <Link to="/signup" className="font-bold underline decoration-3 hover:text-nb-pink">
          SIGN UP
        </Link>
      </p>
    </form>
  );
}
