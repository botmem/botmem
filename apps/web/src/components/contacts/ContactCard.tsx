import { cn, CONNECTOR_COLORS } from '@botmem/shared';
import { Badge } from '../ui/Badge';
import { Avatar } from '../ui/Avatar';
import { IDENTIFIER_COLORS } from './constants';

const SELF_COLOR = '#C4F53A';

interface ContactCardProps {
  contact: {
    id: string;
    displayName: string;
    avatars: Array<{ url: string; source: string }>;
    identifiers: Array<{ type: string; value: string }>;
    connectorSources: string[];
  };
  selected?: boolean;
  isSelf?: boolean;
  onClick?: () => void;
  compact?: boolean;
}

export function ContactCard({ contact, selected, isSelf, onClick, compact }: ContactCardProps) {
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
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && onClick) onClick();
      }}
      className={cn(
        'border-3 border-nb-border bg-nb-surface shadow-nb p-3 cursor-pointer transition-all duration-100',
        'hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-nb-sm',
        selected && 'translate-x-[2px] translate-y-[2px] shadow-nb-sm border-nb-lime',
        compact && 'p-2',
      )}
      style={
        isSelf ? { borderColor: SELF_COLOR, boxShadow: `0 0 10px ${SELF_COLOR}30` } : undefined
      }
    >
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          <Avatar contactId={contact.id} fallbackInitials={initials} isSelf={isSelf} size="sm" />
          {/* Connector source badges */}
          {contact.connectorSources.length > 0 && (
            <div className="absolute -bottom-1 -right-1 flex gap-0.5">
              {contact.connectorSources.map((src) => (
                <div
                  key={src}
                  className="size-4 border border-nb-border flex items-center justify-center"
                  style={{ backgroundColor: CONNECTOR_COLORS[src] || '#999' }}
                  title={src}
                >
                  <span className="text-[8px] font-bold text-black">{src[0].toUpperCase()}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <h3
            className={cn(
              'font-display font-bold uppercase tracking-wider text-nb-text truncate',
              compact ? 'text-xs' : 'text-sm',
            )}
          >
            {contact.displayName}
          </h3>

          <div className="flex flex-wrap gap-1 mt-1">
            {shownIds.map((ident) => (
              <Badge
                key={`${ident.type}-${ident.value}`}
                color={IDENTIFIER_COLORS[ident.type]}
                className="text-[10px] py-0 leading-tight"
              >
                {ident.value}
              </Badge>
            ))}
            {extraCount > 0 && (
              <Badge className="text-[10px] py-0 leading-tight">+{extraCount}</Badge>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
