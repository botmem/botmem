import { cn } from '@botmem/shared';
import { Badge } from '../ui/Badge';
import { IDENTIFIER_COLORS } from './constants';

interface ContactCardProps {
  contact: {
    id: string;
    displayName: string;
    avatars: Array<{ url: string; source: string }>;
    identifiers: Array<{ type: string; value: string }>;
    connectorSources: string[];
  };
  selected?: boolean;
  onClick?: () => void;
  compact?: boolean;
}

export function ContactCard({ contact, selected, onClick, compact }: ContactCardProps) {
  const avatar = contact.avatars?.[0];
  const initials = contact.displayName
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const maxBadges = compact ? 2 : 3;
  const shownIds = contact.identifiers.slice(0, maxBadges);
  const extraCount = contact.identifiers.length - maxBadges;

  return (
    <div
      onClick={onClick}
      className={cn(
        'border-3 border-nb-border bg-nb-surface shadow-nb p-3 cursor-pointer transition-all duration-100',
        'hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-nb-sm',
        selected && 'translate-x-[2px] translate-y-[2px] shadow-nb-sm border-nb-lime',
        compact && 'p-2'
      )}
    >
      <div className="flex items-center gap-3">
        {avatar ? (
          <img
            src={avatar.url}
            alt={contact.displayName}
            className="border-3 border-nb-border w-10 h-10 object-cover shrink-0"
          />
        ) : (
          <div className="border-3 border-nb-border w-10 h-10 bg-nb-lime flex items-center justify-center shrink-0">
            <span className="font-display text-sm font-bold text-black">{initials}</span>
          </div>
        )}

        <div className="flex-1 min-w-0">
          <h3 className={cn('font-display font-bold uppercase tracking-wider text-nb-text truncate', compact ? 'text-xs' : 'text-sm')}>
            {contact.displayName}
          </h3>

          <div className="flex flex-wrap gap-1 mt-1">
            {shownIds.map((ident, i) => (
              <Badge key={i} color={IDENTIFIER_COLORS[ident.type]} className="text-[10px] py-0 leading-tight">
                {ident.value}
              </Badge>
            ))}
            {extraCount > 0 && (
              <Badge className="text-[10px] py-0 leading-tight">+{extraCount}</Badge>
            )}
          </div>

          {!compact && contact.connectorSources.length > 0 && (
            <p className="font-mono text-[10px] text-nb-muted mt-1 truncate">
              {contact.connectorSources.join(' / ')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
