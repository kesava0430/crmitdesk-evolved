import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { api } from '../api/client';

interface Org {
  id: string;
  name: string;
  slug: string;
}

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  department?: string;
  avatarUrl?: string;
  orgId?: string;
  org?: Org;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
}

interface AuthContextType extends AuthState {
  /** Resolves to { requires2FA: true } instead of signing in when the account
   *  has TOTP enabled and no valid code was supplied — call again with
   *  `totpToken` set once the user enters one. */
  login: (email: string, password: string, totpToken?: string) => Promise<{ requires2FA?: boolean }>;
  register: (email: string, password: string, name: string, organizationName: string) => Promise<void>;
  logout: () => void;
  updateProfile: (data: Partial<Pick<User, 'name' | 'email' | 'department' | 'avatarUrl'>>) => Promise<void>;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => {
    const token = localStorage.getItem('accessToken');
    const user = localStorage.getItem('user');
    return { accessToken: token, user: user ? JSON.parse(user) : null };
  });

  const login = useCallback(async (email: string, password: string, totpToken?: string) => {
    const res = await api.post('/auth/login', { email, password, totpToken });
    if (res.data.requires2FA) return { requires2FA: true };
    const { user, access, refresh } = res.data;
    const normalized = { ...user, org: user.org ?? user.organization ?? null };
    localStorage.setItem('accessToken', access);
    localStorage.setItem('refreshToken', refresh);
    localStorage.setItem('user', JSON.stringify(normalized));
    setState({ user: normalized, accessToken: access });
    return {};
  }, []);

  const register = useCallback(async (email: string, password: string, name: string, organizationName: string) => {
    const res = await api.post('/auth/register', { email, password, name, organizationName });
    const { user, access, refresh } = res.data;
    const normalized = { ...user, org: user.org ?? user.organization ?? null };
    localStorage.setItem('accessToken', access);
    localStorage.setItem('refreshToken', refresh);
    localStorage.setItem('user', JSON.stringify(normalized));
    setState({ user: normalized, accessToken: access });
  }, []);

  const logout = useCallback(() => {
    localStorage.clear();
    setState({ user: null, accessToken: null });
  }, []);

  const updateProfile = useCallback(async (data: Partial<Pick<User, 'name' | 'email' | 'department' | 'avatarUrl'>>) => {
    const res = await api.put('/auth/me', data);
    const updated: User = { ...res.data, org: res.data.org ?? res.data.organization ?? null };
    localStorage.setItem('user', JSON.stringify(updated));
    setState(prev => ({ ...prev, user: updated }));
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, register, logout, updateProfile, isAuthenticated: !!state.user }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
