import React from 'react';
import { useTheme } from '../theme';
import { displayFont, bodyFont } from '../fonts';
import { Badge } from './Badge';

type ChatTopbarProps = {
  hasBotmem?: boolean;
  s?: number;
  style?: React.CSSProperties;
};

export const ChatTopbar: React.FC<ChatTopbarProps> = ({ hasBotmem = false, s = 1, style }) => {
  const { colors } = useTheme();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: `0 ${40 * s}px`,
        height: 64 * s,
        background: colors.surface,
        borderBottom: `${4 * s}px solid ${colors.border}`,
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 * s }}>
        {/* Hamburger */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 * s }}>
          <div style={{ width: 20 * s, height: 3 * s, background: colors.text }} />
          <div style={{ width: 20 * s, height: 3 * s, background: colors.text }} />
          <div style={{ width: 14 * s, height: 3 * s, background: colors.text }} />
        </div>
        <span
          style={{
            fontFamily: displayFont,
            fontSize: 14 * s,
            fontWeight: 700,
            color: colors.text,
            letterSpacing: '0.1em',
          }}
        >
          AI AGENT
        </span>
        {hasBotmem && <Badge label="BOTMEM" color={colors.lime} textColor={colors.white} s={s} />}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 * s }}>
        <span
          style={{
            fontFamily: bodyFont,
            fontSize: 11 * s,
            color: colors.muted,
            letterSpacing: '0.05em',
          }}
        >
          MAR 12, 2026
        </span>
        {/* User avatar */}
        <div
          style={{
            width: 32 * s,
            height: 32 * s,
            border: `${3 * s}px solid ${colors.border}`,
            background: colors.surface,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: displayFont,
            fontSize: 12 * s,
            fontWeight: 700,
            color: colors.text,
          }}
        >
          AE
        </div>
      </div>
    </div>
  );
};
