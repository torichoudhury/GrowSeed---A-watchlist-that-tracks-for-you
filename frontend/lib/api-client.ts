import { writeStored } from './browser-store';

/**
 * Empty means same-origin, which is what a deployment behind a rewrite wants:
 * the browser calls /api/... on the site's own domain and the platform proxies
 * it to the backend service. Only local development points at another port —
 * the previous unconditional `|| 'http://localhost:8080'` would have made every
 * visitor's browser call *their own* machine.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL
    ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080');
export const TOKEN_KEY = 'accessToken';
export const USER_KEY = 'user';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

// Writes go through the store so every subscriber (and every other tab) sees
// the session change immediately — see lib/browser-store.ts.
export function setSession(token: string, user: { id: string; email: string }) {
  writeStored(TOKEN_KEY, token);
  writeStored(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  writeStored(TOKEN_KEY, null);
  writeStored(USER_KEY, null);
}

/** Non-reactive read, for code outside React. Components should use
 * `useAuth()`, which subscribes to the store instead. */
export function getStoredUser(): { id: string; email: string } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request(path: string, options: RequestInit = {}) {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });

  if (res.status === 401) {
    clearSession();
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      // Deliberately a hard navigation, not router.push: an expired session
      // should drop every cache and in-memory query this tab is holding.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = '/login';
    }
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status);
  }

  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  get: (path: string) => request(path),
  post: (path: string, body?: unknown) => request(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  delete: (path: string) => request(path, { method: 'DELETE' }),
};

export { API_URL };
