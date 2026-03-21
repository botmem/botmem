import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { useTheme, SPRING_SMOOTH, SPRING_SNAPPY } from '../theme';
import { displayFont, bodyFont } from '../fonts';
import { ConnectorCard } from '../components/ConnectorCard';
import { BotmemLogo } from '../components/BotmemLogo';

export const ConnectScene: React.FC = () => {
  const { colors } = useTheme();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const CONNECTORS = [
    { name: 'Gmail', icon: '📧', color: colors.pink },
    { name: 'Slack', icon: '💬', color: colors.purple },
    { name: 'WhatsApp', icon: '📱', color: colors.green },
    { name: 'iMessage', icon: '💭', color: colors.teal },
    { name: 'Photos', icon: '📸', color: colors.yellow },
  ];

  const logoScale = spring({ frame, fps, config: SPRING_SMOOTH });

  const textOpacity = spring({
    frame,
    fps,
    config: SPRING_SMOOTH,
    delay: 10,
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: colors.bg,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 48,
      }}
    >
      {/* Title */}
      <div
        style={{
          fontFamily: displayFont,
          fontSize: 44,
          fontWeight: 700,
          color: colors.text,
          letterSpacing: '0.1em',
          textTransform: 'uppercase' as const,
          opacity: textOpacity,
        }}
      >
        CONNECT YOUR MEMORY
      </div>

      {/* Connector cards */}
      <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
        {CONNECTORS.map((connector, i) => {
          const p = spring({
            frame,
            fps,
            config: SPRING_SNAPPY,
            delay: 15 + i * 8,
          });
          const tx = interpolate(p, [0, 1], [80, 0]);
          return (
            <div
              key={connector.name}
              style={{
                transform: `translateX(${tx}px)`,
                opacity: p,
              }}
            >
              <ConnectorCard
                name={connector.name}
                icon={connector.icon}
                accentColor={connector.color}
              />
            </div>
          );
        })}
      </div>

      {/* Arrow → Botmem logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <div
          style={{
            fontFamily: displayFont,
            fontSize: 32,
            color: colors.muted,
            opacity: interpolate(frame, [40, 55], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        >
          →
        </div>
        <div style={{ transform: `scale(${logoScale})` }}>
          <BotmemLogo variant="mark" width={56} />
        </div>
      </div>

      {/* Subtitle */}
      <div
        style={{
          fontFamily: bodyFont,
          fontSize: 18,
          color: colors.muted,
          letterSpacing: '0.05em',
          textTransform: 'uppercase' as const,
          opacity: interpolate(frame, [50, 70], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      >
        EMAILS · MESSAGES · PHOTOS · LOCATIONS
      </div>
    </AbsoluteFill>
  );
};
