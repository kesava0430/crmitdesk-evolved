import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Spinner } from '../shared/components';

// Public — the org-specific sign-in link an admin shares with employees
// (see DirectorySSOPage.tsx's "Employee sign-in link"). This is a full-page
// redirect, not an API call: it has to leave the SPA entirely to reach
// Microsoft's own sign-in page, then come back via /sso-callback once
// server-side auth.controller.ts entraCallback finishes the exchange.
export default function EntraLoginPage() {
  const { orgSlug } = useParams();

  useEffect(() => {
    if (!orgSlug) return;
    const apiBase = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
    window.location.href = `${apiBase}/auth/entra/${encodeURIComponent(orgSlug)}/login`;
  }, [orgSlug]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas px-6">
      <Spinner label="Redirecting you to your organization's sign-in..." />
    </div>
  );
}
