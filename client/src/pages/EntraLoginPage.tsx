import { asset } from '../shared/asset';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Spinner } from '../shared/components';
import { APP_NAME } from '../shared/brand';
import { isNative } from '../native/platform';
import { startNativeEntraLogin } from '../native/sso';

// Public — the org-specific sign-in link an admin shares with employees
// (see DirectorySSOPage.tsx's "Employee sign-in link"). This is a full-page
// redirect, not an API call: it has to leave the SPA entirely to reach
// Microsoft's own sign-in page, then come back via /sso-callback once
// server-side auth.controller.ts entraCallback finishes the exchange.
//
// In the Android app the same sign-in runs in a Custom Tab instead (Microsoft
// blocks embedded WebViews) and returns through a deep link that
// native/NativeBridge.tsx handles — see native/sso.ts.
export default function EntraLoginPage() {
  const { orgSlug } = useParams();
  const [error, setError] = useState('');

  useEffect(() => {
    if (!orgSlug) return;
    if (isNative) {
      startNativeEntraLogin(orgSlug).catch(() => setError('Could not open the Microsoft sign-in page. Please try again.'));
      return;
    }
    const apiBase = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
    window.location.href = `${apiBase}/auth/entra/${encodeURIComponent(orgSlug)}/login`;
  }, [orgSlug]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-canvas px-6 gap-4">
      <div className="flex items-center gap-2.5 animate-fade-in">
        <img src={asset("logo.png")} alt="" className="w-9 h-9" />
        <span className="text-xl font-semibold text-fg tracking-tight">{APP_NAME}</span>
      </div>
      {error ? (
        <Alert tone="danger">{error}</Alert>
      ) : (
        <Spinner
          label={isNative ? 'Continue signing in with Microsoft in the browser window…' : "Redirecting you to your organization's sign-in…"}
          compact
        />
      )}
      {isNative && (
        <Link to="/login">
          <Button variant="secondary">Back to sign in</Button>
        </Link>
      )}
    </div>
  );
}
