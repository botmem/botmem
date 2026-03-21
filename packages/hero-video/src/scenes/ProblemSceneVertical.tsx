import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { useTheme } from '../theme';
import { ChatBubble } from '../components/ChatBubble';
import { ChatTopbar } from '../components/ChatTopbar';
import { ChatInput } from '../components/ChatInput';
import { TypeWriter } from '../components/TypeWriter';

const S = 1.8; // mobile scale factor

const USER_MSG = 'I just took Nugget \u{1F415} to the vet. Can you file an insurance claim for me?';
const AI_MSG = "I don't have access to your insurance details or vet records.";
const CHAR_FRAMES = 2;

export const ProblemSceneVertical: React.FC = () => {
  const { colors } = useTheme();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const userTypeDuration = USER_MSG.length * CHAR_FRAMES;
  const aiStartFrame = userTypeDuration + Math.round(fps * 0.5);

  const pulseOpacity = interpolate(frame % 60, [0, 30, 60], [0.8, 1, 0.8], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ backgroundColor: colors.bg }}>
      <ChatTopbar hasBotmem={false} s={S} />

      <div
        style={{
          position: 'absolute',
          top: 68 * S,
          left: 0,
          right: 0,
          bottom: 80 * S,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: `${60 * S}px ${48 * S}px`,
          gap: 36 * S,
        }}
      >
        <ChatBubble variant="user" s={S}>
          <TypeWriter text={USER_MSG} charFrames={CHAR_FRAMES} />
        </ChatBubble>

        {frame >= aiStartFrame && (
          <ChatBubble variant="ai" accentColor={colors.red} s={S}>
            <div style={{ opacity: pulseOpacity }}>
              <TypeWriter
                text={AI_MSG}
                charFrames={CHAR_FRAMES}
                startFrame={aiStartFrame}
                style={{ color: colors.red }}
              />
            </div>
          </ChatBubble>
        )}
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: `${14 * S}px ${48 * S}px`,
          background: colors.bg,
        }}
      >
        <ChatInput s={S} />
      </div>
    </AbsoluteFill>
  );
};
