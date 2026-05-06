import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactDetailPanel } from '../ContactDetailPanel';
import { useContactStore } from '../../../store/contactStore';

vi.mock('../../../lib/api', () => ({
  api: {
    getContactMemories: vi.fn(async () => []),
  },
}));

const baseContact = {
  id: 'person-1',
  displayName: 'Project Lead',
  entityType: 'person',
  avatars: [],
  identifiers: [{ id: 'id-1', type: 'email', value: 'lead@example.com', isPrimary: true }],
  connectorSources: ['gmail'],
};

describe('ContactDetailPanel', () => {
  beforeEach(() => {
    useContactStore.setState({
      contacts: [],
      selectedId: null,
    });
  });

  it('shows merge controls for person records', () => {
    render(
      <ContactDetailPanel
        contact={baseContact}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText('Person Detail')).toBeInTheDocument();
    expect(screen.getByText('Merge another person into this one')).toBeInTheDocument();
  });

  it('hides person merge controls for WhatsApp group-shaped records', () => {
    render(
      <ContactDetailPanel
        contact={{
          ...baseContact,
          id: 'group-1',
          displayName: 'Project Room',
          identifiers: [
            {
              id: 'group-id',
              type: 'phone',
              value: '+120363371012965120',
              isPrimary: true,
            },
          ],
        }}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText('Group Detail')).toBeInTheDocument();
    expect(screen.queryByText('Merge another person into this one')).not.toBeInTheDocument();
  });
});
