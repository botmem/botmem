import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LoginForm } from '../LoginForm';

const mockLoginWithFirebase = vi.hoisted(() => vi.fn());

vi.mock('../../../hooks/useAuth', () => ({
  useAuth: () => ({ login: vi.fn() }),
}));

vi.mock('../../../store/authStore', () => {
  const useAuthStore = Object.assign(
    (
      selector: (state: {
        error: null;
        loginWithFirebase: typeof mockLoginWithFirebase;
      }) => unknown,
    ) => selector({ error: null, loginWithFirebase: mockLoginWithFirebase }),
    {
      getState: () => ({
        user: { onboarded: true },
      }),
    },
  );
  return {
    useAuthStore,
    isFirebaseMode: true,
  };
});

describe('LoginForm', () => {
  it('returns popup Firebase login to the requested destination', async () => {
    mockLoginWithFirebase.mockResolvedValue(undefined);

    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginForm redirectTo="/settings?tab=billing" />} />
          <Route path="/settings" element={<div>settings page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    await waitFor(() => expect(screen.getByText('settings page')).toBeInTheDocument());
    expect(mockLoginWithFirebase).toHaveBeenCalledWith('google');
  });
});
