import '@testing-library/jest-dom/vitest';
import { beforeAll, afterAll } from 'vitest';

// Suppress Node's `--localstorage-file` warning emitted by jsdom environment
const originalEmitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  if (typeof warning === 'string' && warning.includes('--localstorage-file')) return;
  return (originalEmitWarning as (...a: unknown[]) => void).call(process, warning, ...args);
}) as typeof process.emitWarning;

// Suppress console.error/warn in tests (error-path tests trigger these intentionally)
const originalError = console.error;
const originalWarn = console.warn;
beforeAll(() => {
  console.error = () => {};
  console.warn = () => {};
});
afterAll(() => {
  console.error = originalError;
  console.warn = originalWarn;
});
