import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ContactCard } from '../ContactCard';

describe('ContactCard', () => {
  it('hides machine identifiers behind overflow badges', () => {
    render(
      <ContactCard
        contact={{
          id: 'c1',
          displayName: 'Alice',
          avatars: [],
          identifiers: [
            { type: 'whatsapp_lid', value: '123456789' },
            { type: 'apple_contact_id', value: 'ABCD:ABPERSON' },
            { type: 'email', value: 'alice@example.com' },
          ],
          connectorSources: [],
        }}
      />,
    );

    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.queryByText('123456789')).not.toBeInTheDocument();
    expect(screen.queryByText('ABCD:ABPERSON')).not.toBeInTheDocument();
  });
});
