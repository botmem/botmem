import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Memory } from '@botmem/shared';
import { TimelineView } from '../TimelineView';

vi.mock('../StreamGraph', () => ({
  StreamGraph: () => <div data-testid="stream-graph" />,
}));

const memory: Memory = {
  id: 'mem-1',
  source: 'message',
  sourceConnector: 'whatsapp',
  text: 'Readable detail text',
  time: '2026-06-12T10:00:00Z',
  ingestTime: '2026-06-12T10:01:00Z',
  factuality: { label: 'UNVERIFIED', confidence: 0.5, rationale: '' },
  weights: { semantic: 0, recency: 1, importance: 0.2, trust: 0.8, final: 0.7 },
  entities: [],
  claims: [],
  metadata: {},
};

describe('TimelineView', () => {
  it('opens selected memory in a mobile-visible dialog', () => {
    render(<TimelineView memories={[memory]} loading={false} />);

    fireEvent.click(screen.getByRole('button', { name: /readable detail text/i }));

    expect(screen.getByRole('dialog', { name: 'Memory detail' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Close detail' }).length).toBeGreaterThan(0);
  });
});
