import { renderToPipeableStream } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import { Writable } from 'stream';
import { AppRoutes } from './App';

/**
 * Render a route to a complete HTML string.
 * Uses renderToPipeableStream with onAllReady to resolve all Suspense boundaries
 * (including lazy-loaded pages) before producing output.
 */
export function render(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { pipe } = renderToPipeableStream(
      <StaticRouter location={url}>
        <AppRoutes />
      </StaticRouter>,
      {
        onAllReady() {
          const chunks: Buffer[] = [];
          const writable = new Writable({
            write(chunk: Buffer, _encoding: string, callback: () => void) {
              chunks.push(chunk);
              callback();
            },
            final(callback: () => void) {
              resolve(Buffer.concat(chunks).toString('utf-8'));
              callback();
            },
          });
          pipe(writable);
        },
        onError(err: unknown) {
          reject(err);
        },
      },
    );
  });
}
