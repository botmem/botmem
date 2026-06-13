import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthGuard } from '../AuthGuard';

const mockUseAuth = vi.hoisted(() => vi.fn());

vi.mock('../../../hooks/useAuth', () => ({
  useAuth: () => mockUseAuth(),
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

describe('AuthGuard', () => {
  it('waits for auth restoration before redirecting', () => {
    mockUseAuth.mockReturnValue({ user: null, isLoading: true });

    render(
      <MemoryRouter initialEntries={['/settings']}>
        <AuthGuard>
          <div>protected</div>
        </AuthGuard>
      </MemoryRouter>,
    );

    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByText('protected')).not.toBeInTheDocument();
  });

  it('preserves the requested URL when redirecting to login', () => {
    mockUseAuth.mockReturnValue({ user: null, isLoading: false });

    render(
      <MemoryRouter initialEntries={['/settings?tab=billing#keys']}>
        <Routes>
          <Route
            path="/settings"
            element={
              <AuthGuard>
                <div>protected</div>
              </AuthGuard>
            }
          />
          <Route path="/login" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('location')).toHaveTextContent(
      '/login?redirect=%2Fsettings%3Ftab%3Dbilling%23keys',
    );
  });
});
