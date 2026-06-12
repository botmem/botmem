import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Shell } from '../Shell';

vi.mock('../Sidebar', () => ({
  Sidebar: () => <nav data-testid="sidebar" />,
}));

vi.mock('../Topbar', () => ({
  Topbar: ({ onMenuOpen }: { onMenuOpen: () => void }) => (
    <button type="button" onClick={onMenuOpen}>
      menu
    </button>
  ),
}));

vi.mock('../../ui/RecoveryKeyModal', () => ({
  RecoveryKeyModal: () => null,
}));

vi.mock('../../ui/ReauthModal', () => ({
  ReauthModal: () => null,
}));

vi.mock('../../tour/TourManager', () => ({
  TourManager: () => null,
}));

vi.mock('../../../lib/api', () => ({
  api: { getMemoryStats: vi.fn() },
}));

vi.mock('../../../store/authStore', () => {
  const useAuthStore = Object.assign(
    (selector: (state: { accessToken: null; needsRecoveryKey: false }) => unknown) =>
      selector({ accessToken: null, needsRecoveryKey: false }),
    { setState: vi.fn() },
  );
  return { useAuthStore };
});

vi.mock('../../../store/memoryStore', () => ({
  useMemoryStore: { setState: vi.fn() },
}));

describe('Shell', () => {
  it('does not keep the closed mobile sidebar in the DOM', () => {
    render(
      <MemoryRouter>
        <Shell />
      </MemoryRouter>,
    );

    expect(screen.getAllByTestId('sidebar')).toHaveLength(1);
    fireEvent.click(screen.getByText('menu'));
    expect(screen.getAllByTestId('sidebar')).toHaveLength(2);
  });
});
