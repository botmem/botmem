import { cn } from '@/lib/utils';
import { AuthedImage } from './AuthedImage';

const SELF_COLOR = 'var(--color-nb-lime)';

const SIZE_MAP = {
  xs: 'size-6',
  sm: 'size-10',
  md: 'size-12',
  lg: 'size-16',
} as const;

const TEXT_SIZE_MAP = {
  xs: 'text-[8px]',
  sm: 'text-sm',
  md: 'text-sm',
  lg: 'text-lg',
} as const;

interface AvatarProps {
  contactId?: string;
  src?: string;
  name?: string;
  fallbackInitials?: string;
  isSelf?: boolean;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
  borderColor?: string;
}

export function Avatar({
  contactId,
  src,
  name,
  fallbackInitials = '?',
  isSelf,
  size = 'sm',
  className = '',
  borderColor,
}: AvatarProps) {
  const altText = name || (isSelf ? 'Your avatar' : 'User avatar');
  const sizeClass = SIZE_MAP[size];
  const textSize = TEXT_SIZE_MAP[size];
  const border = borderColor || (isSelf ? SELF_COLOR : undefined);
  const borderStyle = border ? { borderColor: border } : undefined;

  const fallbackNode = (
    <div
      className={cn(
        'border-3 border-nb-border flex items-center justify-center',
        sizeClass,
        className,
      )}
      style={{
        backgroundColor: isSelf ? SELF_COLOR : undefined,
        ...borderStyle,
      }}
    >
      <span className={cn('font-display font-bold text-black', textSize)}>
        {isSelf ? '\u2605' : fallbackInitials}
      </span>
    </div>
  );

  // Resolve image source — use src directly for data URIs, proxy for external
  let imgSrc: string | undefined;
  if (src?.startsWith('data:')) {
    imgSrc = src;
  } else if (contactId) {
    imgSrc = `/api/people/${contactId}/avatar`;
  } else if (src) {
    imgSrc = src;
  }

  if (!imgSrc) return fallbackNode;

  // Data URIs don't need auth
  if (imgSrc.startsWith('data:')) {
    return (
      <img
        src={imgSrc}
        alt={altText}
        className={cn('border-3 border-nb-border object-cover', sizeClass, className)}
        style={borderStyle}
      />
    );
  }

  return (
    <AuthedImage
      src={imgSrc}
      alt={altText}
      className={cn('border-3 border-nb-border object-cover', sizeClass, className)}
      fallback={fallbackNode}
    />
  );
}
