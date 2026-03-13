import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryDetailCore } from '../MemoryDetailCore';

describe('MemoryDetailCore', () => {
  const baseProps = {
    id: 'mem-1',
    source: 'message',
    sourceConnector: 'whatsapp',
    text: 'Hello world',
    eventTime: '2026-03-13T10:00:00Z',
  };

  it('shows sender name from metadata when available', () => {
    render(
      <MemoryDetailCore {...baseProps} metadata={{ senderName: 'Alice', senderPhone: '123456' }} />,
    );
    expect(screen.getByText(/Alice/)).toBeDefined();
    expect(screen.getByText(/123456/)).toBeDefined();
  });

  it('falls back to people data when metadata senderName is empty', () => {
    render(
      <MemoryDetailCore
        {...baseProps}
        metadata={{ senderName: '', senderPhone: '971585387813', fromMe: false }}
        people={[
          { role: 'sender', personId: 'p-1', displayName: 'Bob Smith' },
          { role: 'recipient', personId: 'p-2', displayName: 'Amr Essam' },
        ]}
      />,
    );
    expect(screen.getByText(/Bob Smith/)).toBeDefined();
  });

  it('falls back to phone number when no people data', () => {
    render(
      <MemoryDetailCore
        {...baseProps}
        metadata={{ senderName: '', senderPhone: '971585387813' }}
        people={[]}
      />,
    );
    expect(screen.getByText(/971585387813/)).toBeDefined();
  });

  it('resolves recipient name from people for DM', () => {
    render(
      <MemoryDetailCore
        {...baseProps}
        metadata={{
          senderName: 'Amr',
          senderPhone: '971502284498',
          fromMe: true,
          isGroup: false,
          chatId: '971585387813@s.whatsapp.net',
          chatName: '',
        }}
        people={[
          { role: 'sender', personId: 'p-1', displayName: 'Amr Essam' },
          { role: 'recipient', personId: 'p-2', displayName: 'Sarah Ahmed' },
        ]}
      />,
    );
    expect(screen.getByText(/Sarah Ahmed/)).toBeDefined();
  });
});
