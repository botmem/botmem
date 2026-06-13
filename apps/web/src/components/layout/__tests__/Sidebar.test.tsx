import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../Sidebar';

vi.mock('../../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { name: 'Test User', email: 'test@example.com' },
    logout: vi.fn(),
  }),
}));

vi.mock('../../../store/memoryBankStore', () => ({
  useMemoryBankStore: () => ({
    memoryBanks: [],
    activeMemoryBankId: null,
    setActiveMemoryBank: vi.fn(),
    loadMemoryBanks: vi.fn(),
  }),
}));

describe('Sidebar', () => {
  it('uses a focus-visible style distinct from the active item class', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Sidebar />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: /me/i })).toHaveClass('focus-visible:outline-nb-pink');
    expect(screen.getByRole('link', { name: /dashboard/i })).toHaveClass('bg-nb-lime');
  });
});
