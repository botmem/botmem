import React from 'react';
import { useTheme } from '../theme';
import { bodyFont } from '../fonts';

type BadgeProps = {
  label: string;
  color?: string;
  textColor?: string;
  s?: number;
  style?: React.CSSProperties;
};

export const Badge: React.FC<BadgeProps> = ({ label, color, textColor, s = 1, style }) => {
  const { colors } = useTheme();
  const bg = color ?? colors.surfaceMuted;
  const fg = textColor ?? (color ? colors.white : colors.text);

  return (
    <span
      style={{
        display: 'inline-block',
        background: bg,
        color: fg,
        fontFamily: bodyFont,
        fontSize: 12 * s,
        fontWeight: 700,
        padding: `${3 * s}px ${10 * s}px`,
        letterSpacing: '0.05em',
        textTransform: 'uppercase' as const,
        border: `${2 * s}px solid ${colors.border}`,
        ...style,
      }}
    >
      {label}
    </span>
  );
};
