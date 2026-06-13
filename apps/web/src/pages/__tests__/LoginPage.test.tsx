import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { LoginPage } from '../LoginPage';

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: null,
    isLoading: false,
  }),
}));

vi.mock('../../hooks/usePageMeta', () => ({
  usePageMeta: vi.fn(),
}));

vi.mock('../../components/ui/ThemeToggle', () => ({
  ThemeToggle: () => <button type="button">Theme</button>,
}));

vi.mock('../../components/ui/Logo', () => ({
  Logo: () => <div>Botmem</div>,
}));

describe('LoginPage', () => {
  it('pins the desktop theme toggle to the top-right of the brand panel', () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('desktop-theme-toggle')).toHaveClass('absolute', 'top-4', 'right-4');
  });
});
