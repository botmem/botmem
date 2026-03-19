import { useState } from 'react';

interface FacetGroupProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

export function FacetGroup({ title, children, defaultOpen = true }: FacetGroupProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-nb-border/30">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2.5 cursor-pointer"
      >
        <span className="font-display text-xs font-bold uppercase tracking-wider text-nb-muted">
          {title}
        </span>
        <span
          className={`text-nb-muted text-xs transition-transform ${open ? 'rotate-90' : 'rotate-0'}`}
        >
          &#9658;
        </span>
      </button>
      {open && <div className="pb-2">{children}</div>}
    </div>
  );
}
