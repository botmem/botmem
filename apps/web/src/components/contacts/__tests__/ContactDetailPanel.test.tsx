import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => undefined) },
      configurable: true,
    });
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

  it('hides merge controls for list-like group names even when typed as person', () => {
    render(
      <ContactDetailPanel
        contact={{
          ...baseContact,
          displayName: 'Amr <> George intro',
          identifiers: [
            {
              id: 'phone',
              type: 'phone',
              value: '+971500000000',
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

  it('shows full identifier title and copies the value', async () => {
    render(
      <ContactDetailPanel
        contact={{
          ...baseContact,
          identifiers: [
            {
              id: 'long-id',
              type: 'email',
              value: 'very.long.identifier.value@example.com',
              isPrimary: true,
            },
          ],
        }}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByTitle('very.long.identifier.value@example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy email identifier' }));

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'very.long.identifier.value@example.com',
      ),
    );
    expect(screen.getByRole('button', { name: 'Copy email identifier' })).toHaveTextContent('OK');
  });

  it('dedupes group JID chips and renders available members', () => {
    render(
      <ContactDetailPanel
        contact={{
          ...baseContact,
          id: 'group-2',
          displayName: 'Project Group',
          entityType: 'group',
          identifiers: [
            {
              id: 'jid-1',
              type: 'whatsapp_group_jid',
              value: '120363371012965120@g.us',
              isPrimary: true,
            },
            {
              id: 'jid-2',
              type: 'whatsapp_group_jid',
              value: '120363371012965120@g.us',
              isPrimary: false,
            },
          ],
          groupMembers: [
            { displayName: '+971500000001', type: 'phone', value: '+971500000001' },
            { displayName: '+971500000001', type: 'phone', value: '+971500000001' },
            { displayName: 'abc123@lid', type: 'lid', value: 'abc123@lid' },
          ],
        }}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getAllByText('120363371012965120@g.us')).toHaveLength(1);
    expect(screen.getByText('Members (2)')).toBeInTheDocument();
    expect(screen.getAllByText('+971500000001')).toHaveLength(1);
    expect(screen.getByText('abc123@lid')).toBeInTheDocument();
  });

  it('shows an explicit empty member state when the API sends no group members', () => {
    render(
      <ContactDetailPanel
        contact={{
          ...baseContact,
          entityType: 'group',
          identifiers: [{ id: 'group-id', type: 'whatsapp_group_jid', value: 'g@g.us', isPrimary: true }],
        }}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText('No member list available')).toBeInTheDocument();
  });
});
