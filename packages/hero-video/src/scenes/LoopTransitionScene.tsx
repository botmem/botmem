import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { useTheme, SPRING_SMOOTH } from '../theme';
import { displayFont, bodyFont } from '../fonts';
import { BotmemLogo } from '../components/BotmemLogo';

export const LoopTransitionScene: React.FC = () => {
  const { colors } = useTheme();
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const taglineScale = spring({ frame, fps, config: SPRING_SMOOTH });

  const subtitleOpacity = spring({
    frame,
    fps,
    config: SPRING_SMOOTH,
    delay: 8,
  });

  const logoProgress = spring({
    frame,
    fps,
    config: SPRING_SMOOTH,
    delay: 15,
  });

  // Fade-to-bg overlay (fades IN to cover content for seamless loop)
  const fadeOutStart = durationInFrames - 15;
  const overlayOpacity = interpolate(frame, [fadeOutStart, durationInFrames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ backgroundColor: colors.bg }}>
      {/* Content */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          gap: 28,
        }}
      >
        <div
          style={{
            fontFamily: displayFont,
            fontSize: 52,
            fontWeight: 700,
            color: colors.text,
            letterSpacing: '0.08em',
            textTransform: 'uppercase' as const,
            transform: `scale(${taglineScale})`,
            textAlign: 'center',
          }}
        >
          YOUR MEMORY. YOUR AI.
        </div>

        <div
          style={{
            fontFamily: bodyFont,
            fontSize: 20,
            color: colors.muted,
            opacity: subtitleOpacity,
            textAlign: 'center',
            letterSpacing: '0.04em',
          }}
        >
          Give your AI agent the context it needs to act on your behalf.
        </div>

        <div
          style={{
            transform: `scale(${logoProgress})`,
            opacity: logoProgress,
            marginTop: 8,
          }}
        >
          <BotmemLogo variant="full" width={260} />
        </div>
      </div>

      {/* Fade-to-bg overlay for seamless loop */}
      <AbsoluteFill
        style={{
          backgroundColor: colors.bg,
          opacity: overlayOpacity,
          pointerEvents: 'none',
        }}
      />
    </AbsoluteFill>
  );
};
