import { useEffect, lazy, Suspense, type ReactNode } from 'react';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { LoadingScreen } from './components/ui/LoadingScreen';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Shell } from './components/layout/Shell';
import { AuthGuard } from './components/auth/AuthGuard';
import { useAuth } from './hooks/useAuth';
import { useAuthStore } from './store/authStore';
import { posthog, identifyUser } from './lib/posthog';
import { api } from './lib/api';
import { isFirebaseMode } from './lib/auth-provider';
import { appUrl, isAppSurface, isLandingSurface } from './lib/urls';

// Lazy-loaded pages
const LoginPage = lazy(() => import('./pages/LoginPage').then((m) => ({ default: m.LoginPage })));
const SignupPage = lazy(() =>
  import('./pages/SignupPage').then((m) => ({ default: m.SignupPage })),
);
const ForgotPasswordPage = lazy(() =>
  import('./pages/ForgotPasswordPage').then((m) => ({ default: m.ForgotPasswordPage })),
);
const ResetPasswordPage = lazy(() =>
  import('./pages/ResetPasswordPage').then((m) => ({ default: m.ResetPasswordPage })),
);
const OnboardingPage = lazy(() =>
  import('./pages/OnboardingPage').then((m) => ({ default: m.OnboardingPage })),
);
const DashboardPage = lazy(() =>
  import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
const ConnectorsPage = lazy(() =>
  import('./pages/ConnectorsPage').then((m) => ({ default: m.ConnectorsPage })),
);
const ContactsPage = lazy(() =>
  import('./pages/ContactsPage').then((m) => ({ default: m.ContactsPage })),
);
const BridgePage = lazy(() =>
  import('./pages/BridgePage').then((m) => ({ default: m.BridgePage })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const MePage = lazy(() => import('./pages/MePage').then((m) => ({ default: m.MePage })));
const LandingPage = lazy(() =>
  import('./pages/LandingPage').then((m) => ({ default: m.LandingPage })),
);
const PricingPage = lazy(() =>
  import('./pages/PricingPage').then((m) => ({ default: m.PricingPage })),
);
const PrivacyPage = lazy(() =>
  import('./pages/PrivacyPage').then((m) => ({ default: m.PrivacyPage })),
);
const TermsPage = lazy(() => import('./pages/TermsPage').then((m) => ({ default: m.TermsPage })));
const DataPolicyPage = lazy(() =>
  import('./pages/DataPolicyPage').then((m) => ({ default: m.DataPolicyPage })),
);
const OAuthConsentPage = lazy(() => import('./pages/OAuthConsentPage'));
const CliLoginPage = lazy(() => import('./pages/CliLoginPage'));
const NotFoundPage = lazy(() =>
  import('./pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })),
);

function AuthInitializer() {
  const initialize = useAuthStore((s) => s.initialize);

  useEffect(() => {
    initialize();
  }, [initialize]);

  return null;
}

interface PostHogMeData {
  identity?: { email?: string; contactId?: string; name?: string };
  accounts?: unknown[];
  stats?: { totalMemories?: number };
}

function PostHogIdentifier() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  useEffect(() => {
    if (!accessToken || !user) return;
    api
      .getMe<PostHogMeData>()
      .then((data) => {
        const email = user.email || data.identity?.email;
        const userId = user.id || email || data.identity?.contactId || 'botmem-user';
        identifyUser(userId, {
          connectors_count: data.accounts?.length ?? 0,
          memories_count: data.stats?.totalMemories ?? 0,
          name: user.name || data.identity?.name || undefined,
          email: email || undefined,
        });
      })
      .catch(() => {
        // Silently fail -- analytics should never block the app
      });
  }, [accessToken, user]);
  return null;
}

function PostHogPageviewTracker() {
  const location = useLocation();
  useEffect(() => {
    posthog.capture('$pageview');
  }, [location.pathname]);
  return null;
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function LandingOrApp() {
  const { user, isLoading } = useAuth();

  if (isLandingSurface) return <LandingPage />;

  // Hosted Firebase uses the public marketing surface in combined dev builds. App builds are app-first.
  if (isLoading) return isFirebaseMode && !isAppSurface ? <LandingPage /> : <LoadingScreen />;
  if (!user) return isFirebaseMode && !isAppSurface ? <LandingPage /> : <SignupPage />;
  if (!user.onboarded) return <Navigate to="/onboarding" replace />;
  return (
    <>
      <PostHogIdentifier />
      <Navigate to="/me" replace />
    </>
  );
}

/** Shared route tree — used by both client (BrowserRouter) and SSR (StaticRouter) */
export function AppRoutes() {
  const publicMarketingPage = (page: ReactNode) => (isFirebaseMode ? page : <SignupPage />);
  const appRedirect = (path: string) => {
    if (!isLandingSurface) return <Navigate to={path} replace />;
    if (typeof window !== 'undefined') {
      window.location.replace(appUrl(path));
    }
    return <LoadingScreen />;
  };

  if (isLandingSurface) {
    return (
      <>
        <ScrollToTop />
        <PostHogPageviewTracker />
        <ErrorBoundary>
          <Suspense fallback={<LoadingScreen />}>
            <Routes>
              <Route index element={<LandingPage />} />
              <Route path="/landing" element={<Navigate to="/" replace />} />
              <Route path="/pricing" element={<PricingPage />} />
              <Route path="/privacy" element={<PrivacyPage />} />
              <Route path="/terms" element={<TermsPage />} />
              <Route path="/data-policy" element={<DataPolicyPage />} />
              <Route path="/login" element={appRedirect('/login')} />
              <Route path="/signup" element={appRedirect('/signup')} />
              <Route path="/forgot-password" element={appRedirect('/forgot-password')} />
              <Route path="/reset-password" element={appRedirect('/reset-password')} />
              <Route path="/cli-login" element={appRedirect('/cli-login')} />
              <Route path="/oauth/consent" element={appRedirect('/oauth/consent')} />
              <Route path="/dashboard" element={appRedirect('/dashboard')} />
              <Route path="/me" element={appRedirect('/me')} />
              <Route path="/connectors" element={appRedirect('/connectors')} />
              <Route path="/bridge" element={appRedirect('/bridge')} />
              <Route path="/people" element={appRedirect('/people')} />
              <Route path="/contacts" element={appRedirect('/people')} />
              <Route path="/settings" element={appRedirect('/settings')} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </>
    );
  }

  return (
    <>
      <AuthInitializer />
      <ScrollToTop />
      <PostHogPageviewTracker />
      <ErrorBoundary>
        <Suspense fallback={<LoadingScreen />}>
          <Routes>
            <Route index element={<LandingOrApp />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/landing" element={publicMarketingPage(<LandingPage />)} />
            <Route path="/pricing" element={publicMarketingPage(<PricingPage />)} />
            <Route path="/privacy" element={publicMarketingPage(<PrivacyPage />)} />
            <Route path="/terms" element={publicMarketingPage(<TermsPage />)} />
            <Route path="/data-policy" element={publicMarketingPage(<DataPolicyPage />)} />
            <Route path="/oauth/consent" element={<OAuthConsentPage />} />
            <Route path="/cli-login" element={<CliLoginPage />} />
            <Route
              path="/onboarding"
              element={
                <AuthGuard requireOnboarded={false}>
                  <OnboardingPage />
                </AuthGuard>
              }
            />
            <Route
              element={
                <AuthGuard requireOnboarded>
                  <>
                    <PostHogIdentifier />
                    <Shell />
                  </>
                </AuthGuard>
              }
            >
              <Route path="/me" element={<MePage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/connectors" element={<ConnectorsPage />} />
              <Route path="/bridge" element={<BridgePage />} />
              <Route path="/memories" element={<Navigate to="/dashboard" replace />} />
              <Route path="/people" element={<ContactsPage />} />
              <Route path="/contacts" element={<Navigate to="/people" replace />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
            <Route path="/app" element={<Navigate to="/me" replace />} />
            <Route path="/app/me" element={<Navigate to="/me" replace />} />
            <Route path="/app/dashboard" element={<Navigate to="/dashboard" replace />} />
            <Route path="/app/connectors" element={<Navigate to="/connectors" replace />} />
            <Route path="/app/bridge" element={<Navigate to="/bridge" replace />} />
            <Route path="/app/memories" element={<Navigate to="/dashboard" replace />} />
            <Route path="/app/people" element={<Navigate to="/people" replace />} />
            <Route path="/app/contacts" element={<Navigate to="/people" replace />} />
            <Route path="/app/settings" element={<Navigate to="/settings" replace />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
