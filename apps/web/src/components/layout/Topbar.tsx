import { useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Marquee } from '../ui/Marquee';
import { useConnectors } from '../../hooks/useConnectors';
import { api } from '../../lib/api';

const pageTitles: Record<string, string> = {
  '/dashboard': 'DASHBOARD',
  '/connectors': 'CONNECTORS',
  '/memories': 'MEMORY EXPLORER',
  '/contacts': 'PEOPLE',
  '/settings': 'SETTINGS',
};

function useMarqueeText() {
  const { accounts } = useConnectors();
  const [memoryCount, setMemoryCount] = useState<number | null>(null);

  useEffect(() => {
    const fetch = () => {
      api.getMemoryStats().then((s) => setMemoryCount(s.total)).catch(() => {});
    };
    fetch();
    const interval = setInterval(fetch, 15000);
    return () => clearInterval(interval);
  }, []);

  const parts: string[] = [];

  for (const acc of accounts) {
    const name = acc.type.toUpperCase();
    const status = acc.status === 'syncing' ? 'SYNCING...' : acc.status === 'connected' ? 'CONNECTED' : acc.status === 'error' ? 'ERROR' : 'IDLE';
    parts.push(`${name}: ${status}`);
  }

  if (accounts.length === 0) {
    parts.push('NO CONNECTORS CONFIGURED');
  }

  if (memoryCount !== null) {
    parts.push(`${memoryCount.toLocaleString()} MEMORIES INDEXED`);
  }

  return parts.join('  \u2022  ') + '  \u2022  ';
}

export function Topbar() {
  const location = useLocation();
  const title = pageTitles[location.pathname] || 'BOTMEM';
  const marqueeText = useMarqueeText();

  return (
    <header className="border-b-4 border-nb-border bg-nb-surface">
      <div className="flex items-center justify-between px-6 py-3">
        <h2 className="font-display text-2xl font-bold tracking-wider text-nb-text">{title}</h2>
        <div className="font-mono text-xs text-nb-muted uppercase">
          {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
        </div>
      </div>
      <Marquee>{marqueeText}</Marquee>
    </header>
  );
}
