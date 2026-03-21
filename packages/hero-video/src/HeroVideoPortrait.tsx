import React from 'react';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { slide } from '@remotion/transitions/slide';
import { ProblemSceneVertical } from './scenes/ProblemSceneVertical';
import { ConnectSceneVertical } from './scenes/ConnectSceneVertical';
import { MagicSceneVertical } from './scenes/MagicSceneVertical';
import { LoopTransitionSceneVertical } from './scenes/LoopTransitionSceneVertical';
import { getTheme, ThemeProvider, type ThemeMode } from './theme';

export const HeroVideoPortrait: React.FC<{ theme?: ThemeMode }> = ({ theme: mode = 'light' }) => {
  return (
    <ThemeProvider value={getTheme(mode)}>
      <TransitionSeries>
        {/* Scene 1: The Problem (5s) */}
        <TransitionSeries.Sequence durationInFrames={150}>
          <ProblemSceneVertical />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: 15 })}
        />

        {/* Scene 2: Connect Your Data (5s) */}
        <TransitionSeries.Sequence durationInFrames={150}>
          <ConnectSceneVertical />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          presentation={slide({ direction: 'from-right' })}
          timing={linearTiming({ durationInFrames: 20 })}
        />

        {/* Scene 3: The Magic — Multi-turn Agent Chat (30s) */}
        <TransitionSeries.Sequence durationInFrames={900}>
          <MagicSceneVertical />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: 15 })}
        />

        {/* Scene 4: Loop Transition (6s) */}
        <TransitionSeries.Sequence durationInFrames={180}>
          <LoopTransitionSceneVertical />
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </ThemeProvider>
  );
};
