import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { JobTable } from '../dashboard/JobTable';
import type { Job } from '@botmem/shared';

const jobs: Job[] = [
  {
    id: 'j1',
    connector: 'gmail',
    accountId: 'a1',
    accountIdentifier: null,
    status: 'running',
    priority: 0,
    progress: 25,
    total: 100,
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: null,
    error: null,
  },
  {
    id: 'j2',
    connector: 'slack',
    accountId: 'a2',
    accountIdentifier: null,
    status: 'queued',
    priority: 0,
    progress: 0,
    total: 50,
    startedAt: null,
    completedAt: null,
    error: null,
  },
];

describe('JobTable', () => {
  it('renders JOB QUEUE header', () => {
    render(<JobTable jobs={jobs} onCancel={vi.fn()} onMove={vi.fn()} />);
    expect(screen.getByText('JOB QUEUE')).toBeInTheDocument();
  });

  it('shows running count', () => {
    render(<JobTable jobs={jobs} onCancel={vi.fn()} onMove={vi.fn()} />);
    expect(screen.getByText('1 RUNNING')).toBeInTheDocument();
  });

  it('renders empty state when no jobs', () => {
    render(<JobTable jobs={[]} onCancel={vi.fn()} onMove={vi.fn()} />);
    expect(screen.getByText('NO JOBS IN QUEUE')).toBeInTheDocument();
  });

  it('renders job rows', () => {
    render(<JobTable jobs={jobs} onCancel={vi.fn()} onMove={vi.fn()} />);
    expect(screen.getByText('gmail')).toBeInTheDocument();
    expect(screen.getByText('slack')).toBeInTheDocument();
  });
});
