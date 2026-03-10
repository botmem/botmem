import { useEffect } from 'react';
import { Logo } from './components/ui/Logo';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { LoginPage } from './pages/LoginPage';
import { SignupPage } from './pages/SignupPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { DashboardPage } from './pages/DashboardPage';
import { ConnectorsPage } from './pages/ConnectorsPage';
import { MemoryExplorerPage } from './pages/MemoryExplorerPage';
import { ContactsPage } from './pages/ContactsPage';
import { SettingsPage } from './pages/SettingsPage';
import { MePage } from './pages/MePage';
import { LandingPage } from './pages/LandingPage';
import { PricingPage } from './pages/PricingPage';
import OAuthConsentPage from './pages/OAuthConsentPage';
import { Shell } from './components/layout/Shell';
import { AuthGuard } from './components/auth/AuthGuard';
import { useAuth } from './hooks/useAuth';
import { useAuthStore } from './store/authStore';
import { posthog, identifyUser } from './lib/posthog';
import { api } from './lib/api';

function AuthInitializer() {
  const initialize = useAuthStore((s) => s.initialize);

  useEffect(() => {
    initialize();
  }, [initialize]);

  return null;
}

function PostHogIdentifier() {
  const accessToken = useAuthStore((s) => s.accessToken);
  useEffect(() => {
    if (!accessToken) return;
    api
      .getMe()
      .then((data) => {
        const userId = data.identity?.email || data.identity?.contactId || 'botmem-user';
        identifyUser(userId, {
          connectors_count: data.accounts?.length ?? 0,
          memories_count: data.stats?.totalMemories ?? 0,
          name: data.identity?.name ?? undefined,
          email: data.identity?.email ?? undefined,
        });
      })
      .catch(() => {
        // Silently fail -- analytics should never block the app
      });
  }, [accessToken]);
  return null;
}

function PostHogPageviewTracker() {
  const location = useLocation();
  useEffect(() => {
    posthog.capture('$pageview');
  }, [location.pathname]);
  return null;
}

function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-nb-bg">
      <div className="text-center">
        <Logo variant="full" height={40} className="mx-auto mb-4" />
        <div className="font-mono text-sm text-nb-muted">Loading...</div>
      </div>
    </div>
  );
}

function LandingOrApp() {
  const { user, isLoading } = useAuth();

  if (isLoading) return <LoadingScreen />;
  if (!user) return <LandingPage />;
  if (!user.onboarded) return <Navigate to="/onboarding" replace />;
  return (
    <>
      <PostHogIdentifier />
      <Navigate to="/me" replace />
    </>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthInitializer />
      <PostHogPageviewTracker />
      <Routes>
        <Route index element={<LandingOrApp />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/landing" element={<LandingPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/oauth/consent" element={<OAuthConsentPage />} />
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
          <Route path="me" element={<MePage />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="connectors" element={<ConnectorsPage />} />
          <Route path="memories" element={<MemoryExplorerPage />} />
          <Route path="people" element={<ContactsPage />} />
          <Route path="contacts" element={<Navigate to="/people" replace />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
