import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';

const CURSOR_BLINK_FRAMES = 16;

const getTypedText = ({
  frame,
  fullText,
  pauseAfter,
  charFrames,
  pauseFrames,
}: {
  frame: number;
  fullText: string;
  pauseAfter?: string;
  charFrames: number;
  pauseFrames: number;
}): string => {
  const pauseIndex = pauseAfter ? fullText.indexOf(pauseAfter) : -1;
  const preLen = pauseIndex >= 0 ? pauseIndex + pauseAfter!.length : fullText.length;

  let typedChars = 0;
  if (frame < preLen * charFrames) {
    typedChars = Math.floor(frame / charFrames);
  } else if (frame < preLen * charFrames + pauseFrames) {
    typedChars = preLen;
  } else {
    const postPhase = frame - preLen * charFrames - pauseFrames;
    typedChars = Math.min(fullText.length, preLen + Math.floor(postPhase / charFrames));
  }
  return fullText.slice(0, typedChars);
};

const Cursor: React.FC<{ frame: number }> = ({ frame }) => {
  const opacity = interpolate(
    frame % CURSOR_BLINK_FRAMES,
    [0, CURSOR_BLINK_FRAMES / 2, CURSOR_BLINK_FRAMES],
    [1, 0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
  return <span style={{ opacity }}>{'\u258C'}</span>;
};

type TypeWriterProps = {
  text: string;
  pauseAfter?: string;
  charFrames?: number;
  pauseFrames?: number;
  startFrame?: number;
  style?: React.CSSProperties;
};

export const TypeWriter: React.FC<TypeWriterProps> = ({
  text,
  pauseAfter,
  charFrames = 2,
  pauseFrames = 0,
  startFrame = 0,
  style,
}) => {
  const frame = useCurrentFrame();
  const localFrame = Math.max(0, frame - startFrame);

  const typedText = getTypedText({
    frame: localFrame,
    fullText: text,
    pauseAfter,
    charFrames,
    pauseFrames,
  });

  return (
    <span style={style}>
      <span>{typedText}</span>
      {typedText.length < text.length && <Cursor frame={frame} />}
    </span>
  );
};
