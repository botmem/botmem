import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/700.css';
import '@fontsource/space-mono/400.css';
import '@fontsource/space-mono/700.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { BootError } from './BootError.js';
import { BrowserBotmemClient, WebApiError } from './data-client.js';
import { LoginPage } from './LoginPage.js';
import { PricingPage } from './PricingPage.js';
import { PrivacyPage } from './PrivacyPage.js';
import { SignupCompletePage } from './SignupCompletePage.js';
import { parseLoginFragment, rememberWorkspace } from './login-state.js';
import { unavailableReleaseConfiguration } from './mac-release.js';
import { readTheme } from './theme.js';
import './styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('root element is missing');
const root = createRoot(rootElement);
document.documentElement.dataset['theme'] = readTheme();

const baseUrl = import.meta.env['VITE_BOTMEM_API_URL'] ?? window.location.origin;
const client = new BrowserBotmemClient({ baseUrl });
const currentUrl = new URL(window.location.href);
const checkoutSessionId =
  currentUrl.pathname === '/signup/complete'
    ? (currentUrl.searchParams.get('session_id') ?? undefined)
    : undefined;
if (checkoutSessionId) {
  // The Stripe completion capability is read once, then removed before any
  // rendering, navigation, analytics, or referrer can retain it.
  window.history.replaceState(null, '', currentUrl.pathname);
}

if (currentUrl.pathname === '/privacy') {
  document.title = 'Botmem — Privacy';
  root.render(
    <StrictMode>
      <PrivacyPage />
    </StrictMode>,
  );
} else if (currentUrl.pathname === '/pricing') {
  document.title = 'Botmem — Pricing';
  root.render(
    <StrictMode>
      <PricingPage
        client={client}
        checkoutCancelled={currentUrl.searchParams.get('checkout') === 'cancelled'}
      />
    </StrictMode>,
  );
} else if (currentUrl.pathname === '/signup/complete') {
  document.title = 'Botmem — Checkout status';
  root.render(
    <StrictMode>
      <SignupCompletePage
        client={client}
        {...(checkoutSessionId ? { sessionId: checkoutSessionId } : {})}
      />
    </StrictMode>,
  );
} else {
  document.title = 'Botmem — Opening workspace';
  root.render(
    <StrictMode>
      <a className="skip-link" href="#main-content">
        Skip to session check
      </a>
      <main id="main-content" className="boot-error" tabIndex={-1}>
        <p className="eyebrow">BOTMEM WEB / SESSION CHECK</p>
        <h1>Opening your memory.</h1>
        <p role="status">
          Verifying the HttpOnly session. No source data is shown until it passes.
        </p>
      </main>
    </StrictMode>,
  );
  const fragment = parseLoginFragment(window.location.hash);
  let loginError: string | undefined;

  if (fragment.workspaceId) rememberWorkspace(window.localStorage, fragment.workspaceId);
  if (fragment.token) {
    try {
      await client.completeEmailLogin(fragment.token);
    } catch (error) {
      loginError = error instanceof Error ? error.message : 'The sign-in link could not be used.';
    } finally {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
  }

  try {
    const sessionController = new AbortController();
    const sessionTimeout = window.setTimeout(() => sessionController.abort(), 10_000);
    const [session, releases] = await Promise.all([
      client.getSession(sessionController.signal),
      client.getPublicReleases().catch(() => unavailableReleaseConfiguration(baseUrl)),
    ]).finally(() => window.clearTimeout(sessionTimeout));
    root.render(
      <StrictMode>
        <App client={client} workspaceId={session.workspaceId} releases={releases} />
      </StrictMode>,
    );
  } catch (error) {
    const isUnauthenticated = error instanceof WebApiError && error.status === 401;
    document.title = isUnauthenticated ? 'Botmem — Sign in' : 'Botmem — Session unavailable';
    root.render(
      <StrictMode>
        {isUnauthenticated ? (
          <LoginPage client={client} {...(loginError ? { initialError: loginError } : {})} />
        ) : (
          <BootError
            message={
              error instanceof Error ? error.message : 'The authenticated session is unavailable.'
            }
          />
        )}
      </StrictMode>,
    );
  }
}
