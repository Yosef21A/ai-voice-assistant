// Root: provider tree + the auth/tenant gate. main.jsx renders <App/>.
//   I18n  → document dir/lang + translations (outermost, everything needs it)
//   Toast → global notifications
//   Auth  → bootstraps GET /api/auth/me; decides anon vs authed
//   (authed) Tenant + EventStream → the live dashboard shell
import React, { useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { I18nProvider } from './context/I18nContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';
import { TenantProvider, useTenant } from './context/TenantContext.jsx';
import { EventStreamProvider } from './context/EventStreamContext.jsx';
import { AuthScreen } from './screens/AuthScreen.jsx';
import { Shell } from './components/Shell.jsx';
import { LoadingFull } from './components/ui.jsx';
import { navigate } from './router.js';

function Dashboard() {
  const { justSetup } = useAuth();
  const { loading } = useTenant();
  // A freshly bootstrapped owner drops straight into the onboarding wizard.
  useEffect(() => {
    if (justSetup) navigate('/wizard');
  }, [justSetup]);
  if (loading) return <LoadingFull />;
  return <Shell />;
}

function Gate() {
  const { status } = useAuth();
  if (status === 'loading') return <LoadingFull />;
  if (status === 'anon') return <AuthScreen />;
  return (
    <TenantProvider>
      <EventStreamProvider enabled>
        <Dashboard />
      </EventStreamProvider>
    </TenantProvider>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </ToastProvider>
    </I18nProvider>
  );
}
