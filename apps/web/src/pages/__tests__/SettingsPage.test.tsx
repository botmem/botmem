import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '../SettingsPage';

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { name: 'Amr', email: 'amr@example.com' },
  }),
}));

vi.mock('../../lib/api', () => ({
  api: {
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn(),
  },
}));

vi.mock('../../lib/posthog', () => ({
  trackEvent: vi.fn(),
}));

describe('SettingsPage', () => {
  it('renders immutable profile values as full-contrast text, not disabled inputs', () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Amr')).toHaveClass('text-nb-text');
    expect(screen.getByText('amr@example.com')).toHaveClass('text-nb-text');
    expect(screen.queryByDisplayValue('Amr')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('amr@example.com')).not.toBeInTheDocument();
  });
});
