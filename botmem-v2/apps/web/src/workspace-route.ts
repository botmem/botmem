export type WorkspaceView = 'search' | 'connections' | 'devices' | 'billing' | 'account';

export interface ConnectionCallbackNotice {
  readonly connector: 'gmail' | 'outlook';
  readonly status: 'connected';
}

export function workspaceEntry(url: URL): {
  readonly view: WorkspaceView;
  readonly connectionNotice?: ConnectionCallbackNotice;
} {
  if (url.pathname !== '/connections') {
    return {
      view:
        url.pathname === '/device'
          ? 'devices'
          : url.pathname === '/billing'
            ? 'billing'
            : url.pathname === '/account'
              ? 'account'
              : 'search',
    };
  }
  const connector = url.searchParams.get('connector');
  const status = url.searchParams.get('status');
  return {
    view: 'connections',
    ...(status === 'connected' && (connector === 'gmail' || connector === 'outlook')
      ? { connectionNotice: { connector, status } }
      : {}),
  };
}

export function workspacePath(view: WorkspaceView): string {
  switch (view) {
    case 'search':
      return '/';
    case 'connections':
      return '/connections';
    case 'devices':
      return '/device';
    case 'billing':
      return '/billing';
    case 'account':
      return '/account';
  }
}
