"use client";

import { useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api, setSession, clearSession, TOKEN_KEY, USER_KEY } from './api-client';
import { useStoredValue, useStoredJson, useHydrated, writeStored } from './browser-store';

type User = { id: string; email: string };

/**
 * The session lives in localStorage, so it is read as an external store
 * (lib/browser-store.ts) rather than copied into state inside an effect:
 * `ready` then means "hydrated", and signing out in one tab signs out the
 * others too.
 */
export function useAuth() {
  const router = useRouter();
  const ready = useHydrated();
  const user = useStoredJson<User>(USER_KEY);
  const token = useStoredValue<string>(TOKEN_KEY, '', (raw): raw is string => raw.length > 0);

  const login = useCallback(async (email: string, password: string) => {
    const data = await api.post('/api/auth/login', { email, password });
    setSession(data.accessToken, data.user);
    return data.user as User;
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    const data = await api.post('/api/auth/register', { email, password });
    setSession(data.accessToken, data.user);
    return data.user as User;
  }, []);

  const logout = useCallback(() => {
    clearSession();
    router.push('/login');
  }, [router]);

  return { user, ready, isAuthenticated: !!token && !!user, login, register, logout };
}

/** Redirects to /login on mount if no session exists. Call from any page
 * that requires auth, before rendering data-dependent content. */
export function useRequireAuth() {
  const router = useRouter();
  const auth = useAuth();

  // Navigation is an external system, so an effect is the right place for it
  // (what the lint rule forbids is setState here, not side effects).
  useEffect(() => {
    if (auth.ready && !auth.isAuthenticated) router.replace('/login');
  }, [auth.ready, auth.isAuthenticated, router]);

  return auth;
}

/** Re-export so callers that write the session notify the store. */
export { writeStored };
