import '@testing-library/jest-dom/vitest';
import { beforeAll, afterAll } from 'vitest';

// Deterministic in-memory Web Storage. Node 26's experimental localStorage is
// gated behind --localstorage-file and exposes a partial API (setItem missing),
// which makes zustand persist throw during any setState. Install a real
// in-memory implementation so storage-backed code (persist, recovery key) is
// testable regardless of the host's experimental storage support.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number) {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
}
Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
Object.defineProperty(globalThis, 'sessionStorage', {
  value: new MemoryStorage(),
  configurable: true,
});

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
