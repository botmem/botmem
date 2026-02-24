import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConnectorCard } from '../connectors/ConnectorCard';

const defaultConfig = {
  type: 'gmail' as const,
  label: 'Gmail',
  color: '#FF6B9D',
  description: 'Import emails from Gmail',
};

describe('ConnectorCard', () => {
  it('renders connector name', () => {
    render(
      <ConnectorCard config={defaultConfig} connected={false} accountCount={0} onConnect={vi.fn()} />
    );
    expect(screen.getByText('Gmail')).toBeInTheDocument();
  });

  it('renders description when not compact', () => {
    render(
      <ConnectorCard config={defaultConfig} connected={false} accountCount={0} onConnect={vi.fn()} />
    );
    expect(screen.getByText('Import emails from Gmail')).toBeInTheDocument();
  });

  it('hides description when compact', () => {
    render(
      <ConnectorCard config={defaultConfig} connected={false} accountCount={0} onConnect={vi.fn()} compact />
    );
    expect(screen.queryByText('Import emails from Gmail')).not.toBeInTheDocument();
  });

  it('shows CONNECT button when disconnected', () => {
    render(
      <ConnectorCard config={defaultConfig} connected={false} accountCount={0} onConnect={vi.fn()} />
    );
    expect(screen.getByText('CONNECT')).toBeInTheDocument();
  });

  it('shows connected status and ADD ANOTHER when connected', () => {
    render(
      <ConnectorCard config={defaultConfig} connected={true} accountCount={2} onConnect={vi.fn()} />
    );
    expect(screen.getByText(/2 CONNECTED/)).toBeInTheDocument();
    expect(screen.getByText('ADD ANOTHER')).toBeInTheDocument();
  });

  it('calls onConnect when CONNECT clicked', () => {
    const onConnect = vi.fn();
    render(
      <ConnectorCard config={defaultConfig} connected={false} accountCount={0} onConnect={onConnect} />
    );
    fireEvent.click(screen.getByText('CONNECT'));
    expect(onConnect).toHaveBeenCalled();
  });

  it('shows SKIP button when onSkip provided', () => {
    const onSkip = vi.fn();
    render(
      <ConnectorCard config={defaultConfig} connected={false} accountCount={0} onConnect={vi.fn()} onSkip={onSkip} />
    );
    expect(screen.getByText('SKIP')).toBeInTheDocument();
    fireEvent.click(screen.getByText('SKIP'));
    expect(onSkip).toHaveBeenCalled();
  });

  it('does not show SKIP when not provided', () => {
    render(
      <ConnectorCard config={defaultConfig} connected={false} accountCount={0} onConnect={vi.fn()} />
    );
    expect(screen.queryByText('SKIP')).not.toBeInTheDocument();
  });
});
