import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { useAuth } from '../../hooks/useAuth';

export function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/dashboard');
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
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
        onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(e); }}
        placeholder="********"
        required
      />

      <Button type="submit" size="lg" disabled={loading}>
        {loading ? 'SIGNING IN...' : 'SIGN IN'}
      </Button>

      <div className="flex justify-between font-mono text-sm text-nb-text">
        <p>
          No account?{' '}
          <Link to="/signup" className="font-bold underline decoration-3 hover:text-nb-pink">
            SIGN UP
          </Link>
        </p>
        <Link to="/forgot-password" className="font-bold underline decoration-3 hover:text-nb-pink">
          Forgot password?
        </Link>
      </div>
    </form>
  );
}
