import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { useTheme } from '../theme';
import { displayFont, bodyFont } from '../fonts';
import { Badge } from './Badge';

type MemoryCardProps = {
  source: string;
  sourceColor: string;
  snippet: string;
  importance: number;
  fillStartFrame: number;
  fillEndFrame: number;
  s?: number;
  style?: React.CSSProperties;
};

export const MemoryCard: React.FC<MemoryCardProps> = ({
  source,
  sourceColor,
  snippet,
  importance,
  fillStartFrame,
  fillEndFrame,
  s = 1,
  style,
}) => {
  const { colors, shadows } = useTheme();
  const frame = useCurrentFrame();

  const fillWidth = interpolate(frame, [fillStartFrame, fillEndFrame], [0, importance], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        background: colors.surface,
        border: `${3 * s}px solid ${colors.border}`,
        boxShadow: shadows.md,
        padding: `${14 * s}px ${16 * s}px`,
        ...style,
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8 * s,
          marginBottom: 10 * s,
        }}
      >
        {/* Source icon box */}
        <div
          style={{
            width: 28 * s,
            height: 28 * s,
            minWidth: 28 * s,
            border: `${2 * s}px solid ${colors.border}`,
            background: sourceColor,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13 * s,
            lineHeight: 1,
            overflow: 'hidden',
          }}
        >
          {source === 'GMAIL' ? '✉' : source === 'SLACK' ? '◆' : '■'}
        </div>
        <Badge label={source} color={sourceColor} s={s} />
        <span
          style={{
            fontFamily: bodyFont,
            fontSize: 10 * s,
            color: colors.muted,
            letterSpacing: '0.05em',
          }}
        >
          MARCH 5, 2026
        </span>
      </div>

      {/* Snippet */}
      <div
        style={{
          fontFamily: bodyFont,
          fontSize: 14 * s,
          color: colors.text,
          lineHeight: 1.4,
          marginBottom: 12 * s,
        }}
      >
        {snippet}
      </div>

      {/* Importance bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6 * s,
        }}
      >
        <span
          style={{
            fontFamily: displayFont,
            fontSize: 9 * s,
            fontWeight: 700,
            color: colors.muted,
            letterSpacing: '0.1em',
          }}
        >
          IMPORTANCE
        </span>
        <div
          style={{
            width: 64 * s,
            height: 10 * s,
            border: `${2 * s}px solid ${colors.border}`,
            background: colors.surfaceMuted,
          }}
        >
          <div
            style={{
              width: `${fillWidth}%`,
              height: '100%',
              background: colors.purple,
            }}
          />
        </div>
        <span
          style={{
            fontFamily: bodyFont,
            fontSize: 10 * s,
            fontWeight: 700,
            color: colors.purple,
          }}
        >
          {Math.round(fillWidth)}%
        </span>
      </div>
    </div>
  );
};
