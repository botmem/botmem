import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { useTheme, SPRING_SMOOTH, SPRING_SNAPPY } from '../theme';
import { displayFont, bodyFont } from '../fonts';
import { ConnectorCard } from '../components/ConnectorCard';
import { BotmemLogo } from '../components/BotmemLogo';

const S = 1.8; // mobile scale factor

export const ConnectSceneVertical: React.FC = () => {
  const { colors } = useTheme();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const CONNECTORS = [
    { name: 'Gmail', icon: '\u{1F4E7}', color: colors.pink },
    { name: 'Slack', icon: '\u{1F4AC}', color: colors.purple },
    { name: 'WhatsApp', icon: '\u{1F4F1}', color: colors.green },
    { name: 'iMessage', icon: '\u{1F4AD}', color: colors.teal },
    { name: 'Photos', icon: '\u{1F4F8}', color: colors.yellow },
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
        gap: 56 * S,
      }}
    >
      {/* Title */}
      <div
        style={{
          fontFamily: displayFont,
          fontSize: 40 * S,
          fontWeight: 700,
          color: colors.text,
          letterSpacing: '0.1em',
          textTransform: 'uppercase' as const,
          opacity: textOpacity,
          textAlign: 'center',
        }}
      >
        CONNECT YOUR MEMORY
      </div>

      {/* Connector cards — 2 rows: 3 + 2 */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 20 * S,
        }}
      >
        {/* Row 1: first 3 */}
        <div style={{ display: 'flex', gap: 20 * S }}>
          {CONNECTORS.slice(0, 3).map((connector, i) => {
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
                  s={S}
                />
              </div>
            );
          })}
        </div>
        {/* Row 2: last 2 */}
        <div style={{ display: 'flex', gap: 20 * S }}>
          {CONNECTORS.slice(3).map((connector, i) => {
            const p = spring({
              frame,
              fps,
              config: SPRING_SNAPPY,
              delay: 15 + (i + 3) * 8,
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
                  s={S}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Arrow + Botmem logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 * S }}>
        <div
          style={{
            fontFamily: displayFont,
            fontSize: 40 * S,
            color: colors.muted,
            opacity: interpolate(frame, [40, 55], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        >
          {'\u2192'}
        </div>
        <div style={{ transform: `scale(${logoScale})` }}>
          <BotmemLogo variant="mark" width={56 * S} />
        </div>
      </div>

      {/* Subtitle */}
      <div
        style={{
          fontFamily: bodyFont,
          fontSize: 20 * S,
          color: colors.muted,
          letterSpacing: '0.05em',
          textTransform: 'uppercase' as const,
          textAlign: 'center',
          opacity: interpolate(frame, [50, 70], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      >
        {'EMAILS \u00B7 MESSAGES \u00B7 PHOTOS \u00B7 LOCATIONS'}
      </div>
    </AbsoluteFill>
  );
};
