import { loadFont as loadSpaceMono } from '@remotion/google-fonts/SpaceMono';
import { loadFont as loadIBMPlexMono } from '@remotion/google-fonts/IBMPlexMono';

const { fontFamily: displayFont } = loadSpaceMono('normal', {
  weights: ['700'],
  subsets: ['latin'],
});

const { fontFamily: bodyFont } = loadIBMPlexMono('normal', {
  weights: ['400', '700'],
  subsets: ['latin'],
});

export { displayFont, bodyFont };
