"use client";

import { useSyncExternalStore } from 'react';

/**
 * Browser-only values (a stored preference, the saved session) read the React
 * way: as an external store rather than "read localStorage in an effect and
 * setState", which causes a cascading render on every mount and is what
 * `react-hooks/set-state-in-effect` is warning about.
 *
 * A server snapshot keeps SSR honest — the server renders the fallback, and
 * hydration swaps in the stored value — and subscribing to `storage` events
 * means a change in one tab reaches the others for free.
 */

const listeners = new Set<() => void>();

function emit() {
    for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    // Fired by OTHER tabs; same-tab writes go through `writeStored`.
    window.addEventListener('storage', listener);
    return () => {
        listeners.delete(listener);
        window.removeEventListener('storage', listener);
    };
}

/** Snapshots must be referentially stable, or useSyncExternalStore loops. */
const snapshotCache = new Map<string, { raw: string | null; value: unknown }>();

function readStored<T>(key: string, fallback: T, parse: (raw: string) => T | null): T {
    let raw: string | null = null;
    try {
        raw = localStorage.getItem(key);
    } catch {
        return fallback;                      // private mode, storage disabled
    }
    const cached = snapshotCache.get(key);
    if (cached && cached.raw === raw) return cached.value as T;

    const value = raw === null ? fallback : (parse(raw) ?? fallback);
    snapshotCache.set(key, { raw, value });
    return value;
}

export function writeStored(key: string, raw: string | null): void {
    try {
        if (raw === null) localStorage.removeItem(key);
        else localStorage.setItem(key, raw);
    } catch {
        /* private mode — the in-memory value below still applies for this tab */
    }
    snapshotCache.delete(key);
    emit();
}

/** A stored string value, validated on read. */
export function useStoredValue<T extends string>(
    key: string,
    fallback: T,
    isValid: (raw: string) => raw is T
): T {
    return useSyncExternalStore(
        subscribe,
        () => readStored<T>(key, fallback, raw => (isValid(raw) ? raw : null)),
        () => fallback
    );
}

/** A stored JSON object, e.g. the signed-in user. */
export function useStoredJson<T>(key: string): T | null {
    return useSyncExternalStore(
        subscribe,
        () => readStored<T | null>(key, null, raw => { try { return JSON.parse(raw) as T; } catch { return null; } }),
        () => null
    );
}

/** True once the client has hydrated — the point at which stored values are
 * real rather than the server fallback. */
export function useHydrated(): boolean {
    return useSyncExternalStore(subscribe, () => true, () => false);
}
