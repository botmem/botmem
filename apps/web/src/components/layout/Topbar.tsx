import { useLocation } from 'react-router-dom';
import { Marquee } from '../ui/Marquee';

const pageTitles: Record<string, string> = {
  '/dashboard': 'DASHBOARD',
  '/connectors': 'CONNECTORS',
  '/memories': 'MEMORY EXPLORER',
};

export function Topbar() {
  const location = useLocation();
  const title = pageTitles[location.pathname] || 'BOTMEM';

  return (
    <header className="border-b-4 border-nb-border bg-nb-surface">
      <div className="flex items-center justify-between px-6 py-3">
        <h2 className="font-display text-2xl font-bold tracking-wider text-nb-text">{title}</h2>
        <div className="font-mono text-xs text-nb-muted uppercase">
          {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
        </div>
      </div>
      <Marquee>
        GMAIL: SYNCED 2 MIN AGO &nbsp;•&nbsp; SLACK: SYNCING... &nbsp;•&nbsp; WHATSAPP: IDLE &nbsp;•&nbsp; PHOTOS: ERROR - RETRYING &nbsp;•&nbsp; 4,638 MEMORIES INDEXED &nbsp;•&nbsp;
      </Marquee>
    </header>
  );
}
