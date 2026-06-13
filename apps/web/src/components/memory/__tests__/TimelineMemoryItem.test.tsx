import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Memory } from '@botmem/shared';
import { TimelineMemoryItem } from '../TimelineMemoryItem';

const fileMemory: Memory = {
  id: 'mem-file',
  source: 'file',
  sourceConnector: 'gmail',
  accountIdentifier: null,
  text: [
    'File from Gmail',
    '',
    'Connector: gmail',
    '',
    'Original source type: email',
    '',
    'Filename: invoice.pdf',
    '',
    'Document summary:',
    'Invoice total AED 120 for Botmem hosting.',
  ].join('\n'),
  time: '2026-06-01T12:00:00Z',
  ingestTime: '2026-06-01T12:00:00Z',
  factuality: { label: 'UNVERIFIED', confidence: 0.5, rationale: '' },
  weights: { semantic: 1, recency: 1, importance: 1, trust: 1, final: 1 },
  entities: [],
  claims: [],
  metadata: { fileName: 'invoice.pdf' },
  people: [],
};

describe('TimelineMemoryItem', () => {
  it('renders file results with a header and clean snippet', () => {
    render(<TimelineMemoryItem memory={fileMemory} selected={false} onClick={vi.fn()} />);

    expect(screen.getByText('invoice.pdf')).toBeInTheDocument();
    expect(screen.getByText(/Invoice total AED 120/)).toBeInTheDocument();
    expect(screen.queryByText(/Original source type/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Connector: gmail/)).not.toBeInTheDocument();
  });
});
