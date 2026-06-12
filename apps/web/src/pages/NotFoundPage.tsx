import { Link } from 'react-router-dom';
import { usePageMeta } from '../hooks/usePageMeta';

export function NotFoundPage() {
  usePageMeta({
    title: '404 - Botmem',
    robots: 'noindex, nofollow',
  });

  return (
    <main className="min-h-screen bg-nb-bg text-nb-text flex items-center justify-center p-6">
      <section className="w-full max-w-xl border-4 border-nb-border bg-nb-surface p-6 shadow-nb">
        <p className="font-mono text-xs font-bold uppercase text-nb-lime mb-4">$ botmem route</p>
        <h1 className="font-display text-5xl font-bold uppercase mb-4">404</h1>
        <p className="font-mono text-sm text-nb-muted mb-6">
          Unknown route. Nothing was moved, deleted, or silently redirected.
        </p>
        <Link
          to="/"
          className="inline-flex border-3 border-nb-border bg-nb-lime px-4 py-2 font-display text-sm font-bold uppercase text-black shadow-nb-sm hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none focus-visible:outline-3 focus-visible:outline-nb-pink"
        >
          Back
        </Link>
      </section>
    </main>
  );
}
