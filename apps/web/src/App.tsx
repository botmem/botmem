import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { LoginPage } from './pages/LoginPage';
import { SignupPage } from './pages/SignupPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { DashboardPage } from './pages/DashboardPage';
import { ConnectorsPage } from './pages/ConnectorsPage';
import { MemoryExplorerPage } from './pages/MemoryExplorerPage';
import { ContactsPage } from './pages/ContactsPage';
import { SettingsPage } from './pages/SettingsPage';
import { MePage } from './pages/MePage';
import { Shell } from './components/layout/Shell';
import { AuthGuard } from './components/auth/AuthGuard';
import { posthog, identifyUser } from './lib/posthog';

function PostHogIdentifier() {
  useEffect(() => {
    fetch('/api/me')
      .then((r) => r.json())
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
        // Silently fail — analytics should never block the app
      });
  }, []);
  return null;
}

function PostHogPageviewTracker() {
  const location = useLocation();
  useEffect(() => {
    posthog.capture('$pageview');
  }, [location.pathname]);
  return null;
}

export function App() {
  return (
    <BrowserRouter>
      <PostHogPageviewTracker />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route
          path="/onboarding"
          element={
            <AuthGuard requireOnboarded={false}>
              <OnboardingPage />
            </AuthGuard>
          }
        />
        <Route
          path="/"
          element={
            <AuthGuard requireOnboarded>
              <>
                <PostHogIdentifier />
                <Shell />
              </>
            </AuthGuard>
          }
        >
          <Route index element={<Navigate to="/me" replace />} />
          <Route path="me" element={<MePage />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="connectors" element={<ConnectorsPage />} />
          <Route path="memories" element={<MemoryExplorerPage />} />
          <Route path="contacts" element={<ContactsPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
