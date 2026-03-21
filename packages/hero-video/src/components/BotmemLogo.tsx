import React from 'react';
import { Img, staticFile } from 'remotion';

type BotmemLogoProps = {
  variant?: 'full' | 'mark';
  width?: number;
  style?: React.CSSProperties;
};

export const BotmemLogo: React.FC<BotmemLogoProps> = ({ variant = 'full', width = 200, style }) => {
  const src = variant === 'mark' ? staticFile('logo-mark.svg') : staticFile('logo.svg');

  return <Img src={src} style={{ width, ...style }} />;
};
