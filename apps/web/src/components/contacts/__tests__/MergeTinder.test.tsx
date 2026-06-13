import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MergeTinder } from '../MergeTinder';

const contact = {
  id: 'c1',
  displayName: '',
  avatars: [],
  identifiers: [{ type: 'email', value: 'a@example.com' }],
  connectorSources: [],
};

describe('MergeTinder', () => {
  it('sanitizes evidence text and hides too-short shared surnames', async () => {
    render(
      <MergeTinder
        suggestions={[
          {
            contact1: contact,
            contact2: { ...contact, id: 'c2', displayName: 'Ali Example' },
            reason: '\u202eshared reason “quoted”',
            positiveEvidence: ['shared surname “A”', 'shared surname “Ali”'],
            negativeEvidence: ['different first names \u202e“Amr” / “Ali”'],
          },
        ]}
        onMerge={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(await screen.findByText('Merge Review')).toBeInTheDocument();
    expect(screen.getByText('shared reason "quoted"')).toBeInTheDocument();
    expect(screen.queryByText('shared surname "A"')).not.toBeInTheDocument();
    expect(screen.getByText('shared surname "Ali"')).toBeInTheDocument();
    expect(screen.getByText('different first names "Amr" / "Ali"')).toBeInTheDocument();
    expect(screen.getByText('?')).toBeInTheDocument();
  });
});
