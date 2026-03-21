import React from 'react';
import { useTheme } from '../theme';
import { bodyFont, displayFont } from '../fonts';

type ChatInputProps = {
  text?: string;
  isFocused?: boolean;
  s?: number;
  style?: React.CSSProperties;
};

export const ChatInput: React.FC<ChatInputProps> = ({ text, isFocused = false, s = 1, style }) => {
  const { colors, shadows } = useTheme();
  return (
    <div
      style={{
        display: 'flex',
        gap: 0,
        ...style,
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 44 * s,
          padding: `${12 * s}px ${18 * s}px`,
          background: colors.surface,
          border: `${3 * s}px solid ${isFocused ? colors.lime : colors.border}`,
          boxShadow: isFocused ? shadows.sm : undefined,
          fontFamily: bodyFont,
          fontSize: 14 * s,
          color: text ? colors.text : colors.muted,
          letterSpacing: '0.05em',
          textTransform: text ? undefined : ('uppercase' as const),
          display: 'flex',
          alignItems: 'center',
        }}
      >
        {text || 'TYPE YOUR MESSAGE...'}
      </div>
      <div
        style={{
          width: 48 * s,
          minHeight: 44 * s,
          background: colors.lime,
          border: `${3 * s}px solid ${colors.border}`,
          borderLeft: 'none',
          boxShadow: shadows.md,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: displayFont,
          fontSize: 20 * s,
          color: colors.white,
          fontWeight: 700,
        }}
      >
        →
      </div>
    </div>
  );
};
