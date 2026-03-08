import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LogEntryRow } from '../dashboard/LogEntry';
import type { LogEntry } from '@botmem/shared';

describe('LogEntryRow', () => {
  it('renders log message', () => {
    const entry: LogEntry = {
      id: 'l1',
      timestamp: '2026-02-23T14:30:00Z',
      level: 'info',
      connector: 'gmail',
      message: 'Sync started successfully',
    };
    render(<LogEntryRow entry={entry} />);
    expect(screen.getByText('Sync started successfully')).toBeInTheDocument();
  });

  it('renders connector name', () => {
    const entry: LogEntry = {
      id: 'l2',
      timestamp: '2026-02-23T14:30:00Z',
      level: 'warn',
      connector: 'slack',
      message: 'Rate limited',
    };
    render(<LogEntryRow entry={entry} />);
    expect(screen.getByText('slack')).toBeInTheDocument();
  });

  it('renders level badge', () => {
    const entry: LogEntry = {
      id: 'l3',
      timestamp: '2026-02-23T14:30:00Z',
      level: 'error',
      connector: 'gmail',
      message: 'API failure',
    };
    render(<LogEntryRow entry={entry} />);
    expect(screen.getByText('error')).toBeInTheDocument();
  });

  it('renders formatted timestamp', () => {
    const entry: LogEntry = {
      id: 'l4',
      timestamp: '2026-02-23T14:30:45Z',
      level: 'debug',
      connector: 'whatsapp',
      message: 'Debug info',
    };
    render(<LogEntryRow entry={entry} />);
    // formatTime returns HH:MM:SS format
    const timeElement = screen.getByText(/\d{2}:\d{2}:\d{2}/);
    expect(timeElement).toBeInTheDocument();
  });

  it('renders all log levels', () => {
    const levels = ['info', 'warn', 'error', 'debug'] as const;
    levels.forEach((level) => {
      const entry: LogEntry = {
        id: `l-${level}`,
        timestamp: '2026-02-23T14:30:00Z',
        level,
        connector: 'gmail',
        message: `${level} message`,
      };
      const { unmount } = render(<LogEntryRow entry={entry} />);
      expect(screen.getByText(level)).toBeInTheDocument();
      unmount();
    });
  });
});
