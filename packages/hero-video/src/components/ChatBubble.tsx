import React from 'react';
import { useTheme } from '../theme';
import { displayFont, bodyFont } from '../fonts';

type ChatBubbleProps = {
  variant: 'user' | 'ai';
  label?: string;
  accentColor?: string;
  children: React.ReactNode;
  s?: number;
  style?: React.CSSProperties;
};

export const ChatBubble: React.FC<ChatBubbleProps> = ({
  variant,
  label,
  accentColor,
  children,
  s = 1,
  style,
}) => {
  const { colors, shadows } = useTheme();
  const isUser = variant === 'user';

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        width: '100%',
        ...style,
      }}
    >
      <div
        style={{
          background: colors.surface,
          border: `${3 * s}px solid ${isUser ? colors.border : (accentColor ?? colors.border)}`,
          boxShadow: shadows.md,
          padding: `${16 * s}px ${24 * s}px`,
          maxWidth: isUser ? '70%' : '80%',
          fontFamily: bodyFont,
          fontSize: 26 * s,
          lineHeight: 1.5,
          color: colors.text,
        }}
      >
        {/* Label */}
        <div
          style={{
            fontFamily: displayFont,
            fontSize: 12 * s,
            fontWeight: 700,
            color: isUser ? colors.lime : (accentColor ?? colors.muted),
            marginBottom: 8 * s,
            letterSpacing: '0.1em',
            textTransform: 'uppercase' as const,
          }}
        >
          {label ?? (isUser ? 'YOU' : 'AI AGENT')}
        </div>
        {children}
      </div>
    </div>
  );
};
