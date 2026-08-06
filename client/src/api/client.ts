import axios from 'axios';
import { addToast } from '../shared/components/toastStore';

// VITE_API_URL is required whenever the frontend and backend are on different
// origins (e.g. Netlify frontend + Render backend) — this used to be
// hardcoded to '/api', silently ignoring the env var entirely. That only
// ever worked by accident on Render's own static-site option, which has an
// explicit /api/* redirect proxy in render.yaml papering over it; any other
// host (Netlify included) sent every request to its own domain instead of
// the API, which doesn't exist there.
export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || '/api' });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('accessToken');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// The refresh endpoint rotates the refresh token (invalidates the old one,
// issues a new pair — see auth.controller.ts refreshToken). A page like the
// dashboard fires several requests in parallel on mount; if the access token
// happened to expire right then, EVERY one of those requests would 401 at
// once and — without this — each would independently call /auth/refresh
// with the same (soon-to-be-invalidated) refresh token. Only the first of
// those calls succeeds; the rest get "Invalid refresh token" back, and each
// one wiped localStorage and hard-redirected to /login in response — even
// though the very first refresh had just succeeded and the session was
// completely fine. That's the "loads, spins for a bit, then dumps you on
// the login screen" bug: it wasn't really an expired session, just this
// race. The fix is to share a single in-flight refresh across every
// concurrent 401 instead of letting each request start its own.
let refreshPromise: Promise<{ access: string; refresh?: string }> | null = null;
let loggedOutFromExpiry = false;

function performRefresh() {
  if (!refreshPromise) {
    const refresh = localStorage.getItem('refreshToken');
    // api.post, not a bare axios.post('/api/auth/refresh', ...) — the
    // bare call hardcoded a relative path that bypassed baseURL/
    // VITE_API_URL entirely, same bug as the baseURL default above.
    refreshPromise = api.post('/auth/refresh', { refresh })
      .then(res => res.data)
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;

    // 401: try token refresh first — but never intercept the login/refresh endpoints themselves
    const requestUrl: string = original?.url ?? '';
    const isAuthEndpoint =
      requestUrl.includes('/auth/login') || requestUrl.includes('/auth/refresh');

    if (error.response?.status === 401 && !original._retry && !isAuthEndpoint) {
      original._retry = true;
      try {
        const data = await performRefresh();
        localStorage.setItem('accessToken', data.access);
        if (data.refresh) localStorage.setItem('refreshToken', data.refresh);
        original.headers.Authorization = `Bearer ${data.access}`;
        return api(original);
      } catch {
        if (!loggedOutFromExpiry) {
          loggedOutFromExpiry = true;
          addToast('Your session has expired — please sign in again.', 'warning', { duration: 6000 });
          localStorage.clear();
          window.location.href = '/login';
        }
        return Promise.reject(error);
      }
    }

    // Show toast for all other non-401 errors
    const status: number | undefined = error.response?.status;
    const serverMsg: string | undefined =
      error.response?.data?.error || error.response?.data?.message;

    if (!error.response) {
      addToast(
        'Cannot reach the server. Make sure the backend is running and the database is connected.',
        'error'
      );
    } else if (status === 403) {
      addToast("You don't have permission to perform this action.", 'warning');
    } else if (status === 402) {
      addToast(serverMsg || "You've hit your plan's seat limit.", 'warning', {
        duration: 10000,
        actionLabel: 'Upgrade plan',
        actionHref: '/billing',
      });
    } else if (status === 409) {
      addToast(serverMsg || 'A conflict occurred — this item may already exist.', 'warning');
    } else if (status === 422) {
      addToast(serverMsg || 'Validation failed — check your inputs.', 'warning');
    } else if (status === 429) {
      addToast('Too many requests — please slow down.', 'warning');
    } else if (status && status >= 500) {
      addToast(
        serverMsg ? `Server error: ${serverMsg}` : 'A server error occurred. Try again in a moment.',
        'error'
      );
    } else if (status && status >= 400 && status !== 401) {
      addToast(serverMsg || 'Something went wrong.', 'error');
    }

    return Promise.reject(error);
  }
);
