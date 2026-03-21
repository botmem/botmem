import React from 'react';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { slide } from '@remotion/transitions/slide';
import { ProblemScene } from './scenes/ProblemScene';
import { ConnectScene } from './scenes/ConnectScene';
import { MagicScene } from './scenes/MagicScene';
import { LoopTransitionScene } from './scenes/LoopTransitionScene';
import { getTheme, ThemeProvider, type ThemeMode } from './theme';

export const HeroVideo: React.FC<{ theme?: ThemeMode }> = ({ theme: mode = 'light' }) => {
  return (
    <ThemeProvider value={getTheme(mode)}>
      <TransitionSeries>
        {/* Scene 1: The Problem (5s) */}
        <TransitionSeries.Sequence durationInFrames={150}>
          <ProblemScene />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: 15 })}
        />

        {/* Scene 2: Connect Your Data (5s) */}
        <TransitionSeries.Sequence durationInFrames={150}>
          <ConnectScene />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          presentation={slide({ direction: 'from-right' })}
          timing={linearTiming({ durationInFrames: 20 })}
        />

        {/* Scene 3: The Magic — Multi-turn Agent Chat (30s) */}
        <TransitionSeries.Sequence durationInFrames={900}>
          <MagicScene />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: 15 })}
        />

        {/* Scene 4: Loop Transition (6s) */}
        <TransitionSeries.Sequence durationInFrames={180}>
          <LoopTransitionScene />
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </ThemeProvider>
  );
};
