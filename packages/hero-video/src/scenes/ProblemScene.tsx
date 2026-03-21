import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { useTheme } from '../theme';
import { ChatBubble } from '../components/ChatBubble';
import { ChatTopbar } from '../components/ChatTopbar';
import { ChatInput } from '../components/ChatInput';
import { TypeWriter } from '../components/TypeWriter';

const USER_MSG = 'I just took Nugget 🐕 to the vet. Can you file an insurance claim for me?';
const AI_MSG = "I don't have access to your insurance details or vet records.";
const CHAR_FRAMES = 2;

export const ProblemScene: React.FC = () => {
  const { colors } = useTheme();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const userTypeDuration = USER_MSG.length * CHAR_FRAMES;
  const aiStartFrame = userTypeDuration + Math.round(fps * 0.5);

  // Red pulse on error
  const pulseOpacity = interpolate(frame % 60, [0, 30, 60], [0.8, 1, 0.8], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ backgroundColor: colors.bg }}>
      {/* App topbar */}
      <ChatTopbar hasBotmem={false} />

      {/* Chat messages area */}
      <div
        style={{
          position: 'absolute',
          top: 68,
          left: 0,
          right: 0,
          bottom: 64,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '40px 100px',
          gap: 24,
        }}
      >
        <ChatBubble variant="user">
          <TypeWriter text={USER_MSG} charFrames={CHAR_FRAMES} />
        </ChatBubble>

        {frame >= aiStartFrame && (
          <ChatBubble variant="ai" accentColor={colors.red}>
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

      {/* Input bar at bottom */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: '10px 100px',
          background: colors.bg,
        }}
      >
        <ChatInput />
      </div>
    </AbsoluteFill>
  );
};
