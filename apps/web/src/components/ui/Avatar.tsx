import { AuthedImage } from './AuthedImage';

const SELF_COLOR = '#C4F53A';

const SIZE_MAP = {
  xs: 'w-6 h-6',
  sm: 'w-10 h-10',
  md: 'w-12 h-12',
  lg: 'w-16 h-16',
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
  fallbackInitials?: string;
  isSelf?: boolean;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
  borderColor?: string;
}

export function Avatar({
  contactId,
  src,
  fallbackInitials = '?',
  isSelf,
  size = 'sm',
  className = '',
  borderColor,
}: AvatarProps) {
  const sizeClass = SIZE_MAP[size];
  const textSize = TEXT_SIZE_MAP[size];
  const border = borderColor || (isSelf ? SELF_COLOR : undefined);
  const borderStyle = border ? { borderColor: border } : undefined;

  const fallbackNode = (
    <div
      className={`border-3 border-nb-border ${sizeClass} flex items-center justify-center ${className}`}
      style={{
        backgroundColor: isSelf ? SELF_COLOR : undefined,
        ...borderStyle,
      }}
    >
      <span className={`font-display ${textSize} font-bold text-black`}>
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
        alt=""
        className={`border-3 border-nb-border ${sizeClass} object-cover ${className}`}
        style={borderStyle}
      />
    );
  }

  return (
    <AuthedImage
      src={imgSrc}
      alt=""
      className={`border-3 border-nb-border ${sizeClass} object-cover ${className}`}
      fallback={fallbackNode}
    />
  );
}
