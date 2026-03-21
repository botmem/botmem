import React from 'react';
import { spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { useTheme, SPRING_SNAPPY } from '../theme';
import { displayFont, bodyFont } from '../fonts';

type ToolCallCardProps = {
  fnName: string;
  query: string;
  result: string;
  appearFrame: number;
  resultDelay?: number;
  s?: number;
  style?: React.CSSProperties;
};

export const ToolCallCard: React.FC<ToolCallCardProps> = ({
  fnName,
  query,
  result,
  appearFrame,
  resultDelay = 25,
  s = 1,
  style,
}) => {
  const { colors, shadows } = useTheme();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const localFrame = Math.max(0, frame - appearFrame);

  const cardProgress = spring({
    frame: localFrame,
    fps,
    config: SPRING_SNAPPY,
  });

  const resultProgress = spring({
    frame: Math.max(0, localFrame - resultDelay),
    fps,
    config: { damping: 200 },
  });

  const isLoading = localFrame < resultDelay;
  const dotCount = isLoading ? (Math.floor(localFrame / 6) % 3) + 1 : 3;

  return (
    <div
      style={{
        transform: `scale(${cardProgress})`,
        opacity: cardProgress,
        transformOrigin: 'top left',
        background: colors.surfaceMuted,
        border: `${3 * s}px solid ${colors.border}`,
        boxShadow: shadows.sm,
        padding: `${12 * s}px ${18 * s}px`,
        width: '100%',
        maxWidth: 680 * s,
        ...style,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8 * s,
          marginBottom: 8 * s,
        }}
      >
        <div
          style={{
            width: 10 * s,
            height: 10 * s,
            background: isLoading ? colors.orange : colors.lime,
            border: `${2 * s}px solid ${colors.borderStrong}`,
          }}
        />
        <span
          style={{
            fontFamily: displayFont,
            fontSize: 10 * s,
            fontWeight: 700,
            color: isLoading ? colors.orange : colors.lime,
            letterSpacing: '0.1em',
          }}
        >
          TOOL CALL
        </span>
      </div>

      {/* Function signature */}
      <div
        style={{
          fontFamily: bodyFont,
          fontSize: 16 * s,
          color: colors.text,
          marginBottom: resultProgress > 0.1 ? 8 * s : 0,
        }}
      >
        <span style={{ color: colors.purple }}>{fnName}</span>
        <span style={{ color: colors.muted }}>(</span>
        <span style={{ color: colors.orange }}>"{query}"</span>
        <span style={{ color: colors.muted }}>)</span>
      </div>

      {/* Loading or result */}
      {isLoading ? (
        <div
          style={{
            fontFamily: displayFont,
            fontSize: 11 * s,
            color: colors.muted,
            marginTop: 4 * s,
            letterSpacing: '0.1em',
          }}
        >
          SEARCHING{'.'.repeat(dotCount)}
        </div>
      ) : (
        <div
          style={{
            fontFamily: bodyFont,
            fontSize: 14 * s,
            color: colors.teal,
            opacity: resultProgress,
            lineHeight: 1.4,
            borderTop: `${2 * s}px solid ${colors.border}`,
            paddingTop: 6 * s,
            marginTop: 4 * s,
          }}
        >
          → {result}
        </div>
      )}
    </div>
  );
};
