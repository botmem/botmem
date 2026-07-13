import { ThemeToggle } from './ThemeToggle.js';

export function BootError({
  message = 'Sign in again to restore access.',
}: {
  readonly message?: string;
}) {
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to session error
      </a>
      <div className="public-theme-control">
        <ThemeToggle />
      </div>
      <main id="main-content" className="boot-error" tabIndex={-1}>
        <p className="eyebrow">BOTMEM WEB / LOCKED</p>
        <h1>Session context is missing.</h1>
        <p>{message} No source data was loaded.</p>
      </main>
    </>
  );
}
