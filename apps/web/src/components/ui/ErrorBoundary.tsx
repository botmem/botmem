import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="flex flex-col items-center justify-center p-8 border-3 border-nb-red bg-nb-surface">
            <p className="font-display text-lg font-bold uppercase text-nb-text mb-2">
              Something went wrong
            </p>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false })}
              className="border-3 border-nb-border px-4 py-2 font-mono text-sm font-bold uppercase bg-nb-surface text-nb-text hover:bg-nb-lime hover:text-black cursor-pointer transition-colors"
            >
              Try Again
            </button>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
