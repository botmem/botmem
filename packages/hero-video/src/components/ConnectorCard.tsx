import React from 'react';
import { useTheme } from '../theme';
import { displayFont } from '../fonts';

type ConnectorCardProps = {
  name: string;
  icon: string;
  accentColor: string;
  s?: number;
  style?: React.CSSProperties;
};

export const ConnectorCard: React.FC<ConnectorCardProps> = ({
  name,
  icon,
  accentColor,
  s = 1,
  style,
}) => {
  const { colors, shadows } = useTheme();
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10 * s,
        background: colors.surface,
        border: `${3 * s}px solid ${colors.border}`,
        boxShadow: shadows.md,
        padding: `${18 * s}px ${20 * s}px`,
        width: 130 * s,
        position: 'relative' as const,
        ...style,
      }}
    >
      {/* Status dot */}
      <div
        style={{
          width: 8 * s,
          height: 8 * s,
          background: accentColor,
          border: `${2 * s}px solid ${colors.borderStrong}`,
          position: 'absolute' as const,
          top: 8 * s,
          right: 8 * s,
        }}
      />
      <div
        style={{
          fontSize: 32 * s,
          lineHeight: 1,
          height: 36 * s,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </div>
      <div
        style={{
          fontFamily: displayFont,
          fontSize: 13 * s,
          fontWeight: 700,
          color: colors.text,
          letterSpacing: '0.1em',
          textTransform: 'uppercase' as const,
        }}
      >
        {name}
      </div>
      {/* Accent bar at bottom */}
      <div
        style={{
          width: '100%',
          height: 3 * s,
          background: accentColor,
        }}
      />
    </div>
  );
};
