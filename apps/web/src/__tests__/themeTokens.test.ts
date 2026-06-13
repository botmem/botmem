import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

function tokenValue(source: string, token: string) {
  const match = source.match(new RegExp(`${token}:\\s*(#[0-9A-Fa-f]{6})`));
  return match?.[1];
}

function relativeLuminance(hex: string) {
  const channels = hex
    .slice(1)
    .match(/../g)!
    .map((part) => parseInt(part, 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));

  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(a: string, b: string) {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

describe('theme tokens', () => {
  it('keeps light-mode lime bright enough for black accent text', () => {
    const lightTheme = css.match(/\[data-theme="light"\]\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const lime = tokenValue(lightTheme, '--color-nb-lime');

    expect(lime).toBe('#C4F53A');
    expect(contrast(lime!, '#000000')).toBeGreaterThanOrEqual(7);
  });
});
