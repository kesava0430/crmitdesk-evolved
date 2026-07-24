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
        const refresh = localStorage.getItem('refreshToken');
        // api.post, not a bare axios.post('/api/auth/refresh', ...) — the
        // bare call hardcoded a relative path that bypassed baseURL/
        // VITE_API_URL entirely, same bug as the baseURL default above.
        const res = await api.post('/auth/refresh', { refresh });
        localStorage.setItem('accessToken', res.data.access);
        if (res.data.refresh) localStorage.setItem('refreshToken', res.data.refresh);
        original.headers.Authorization = `Bearer ${res.data.access}`;
        return api(original);
      } catch {
        localStorage.clear();
        window.location.href = '/login';
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
