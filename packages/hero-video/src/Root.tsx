import React from 'react';
import { Composition } from 'remotion';
import { HeroVideo } from './HeroVideo';
import { HeroVideoPortrait } from './HeroVideoPortrait';

const FPS = 30;
// Scene durations: 150 + 150 + 900 + 180 = 1380
// Transitions: -15 - 20 - 15 = -50
// Total: 1330 frames ≈ 44.3s
const DURATION = 1330;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* Landscape (16:9) */}
      <Composition
        id="HeroVideo"
        component={HeroVideo}
        durationInFrames={DURATION}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ theme: 'light' as const }}
      />
      <Composition
        id="HeroVideoDark"
        component={HeroVideo}
        durationInFrames={DURATION}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ theme: 'dark' as const }}
      />

      {/* Portrait (9:16) */}
      <Composition
        id="HeroVideoPortrait"
        component={HeroVideoPortrait}
        durationInFrames={DURATION}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{ theme: 'light' as const }}
      />
      <Composition
        id="HeroVideoPortraitDark"
        component={HeroVideoPortrait}
        durationInFrames={DURATION}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{ theme: 'dark' as const }}
      />
    </>
  );
};
