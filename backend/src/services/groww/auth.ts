import crypto from 'crypto';
import { redisClient } from '../../config/redis';

/**
 * Groww Trade API auth (https://groww.in/trade-api/docs/curl) — key+secret
 * "approval" flow. Groww's dashboard requires a one-time manual approval
 * click once daily for this flow (the TOTP flow avoids that but wasn't the
 * credential pair provided) — so a login can start failing once a day until
 * that click happens again; the resulting error surfaces through the normal
 * PROVIDER_DOWN fallback chain rather than crashing anything.
 */

const GROWW_BASE_URL = 'https://api.groww.in/v1';
const TOKEN_CACHE_KEY = 'groww:access_token';
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // re-auth 5 min before expiry, not exactly at it

interface CachedToken {
    token: string;
    expiresAtMs: number;
}

/** Decode the exp claim straight out of the session JWT — the response
 * body's own `expiry` string has no timezone marker, and Groww is IST-based,
 * so trusting it verbatim would silently misfire on any server not already
 * running in IST. The token's `exp` claim is an unambiguous Unix timestamp. */
function expiryFromJwt(token: string, fallback: number): number {
    try {
        const payloadB64 = token.split('.')[1];
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
        if (typeof payload.exp === 'number') return payload.exp * 1000;
    } catch {
        // fall through
    }
    return fallback;
}

let inFlight: Promise<string> | null = null;

async function loginWithApproval(): Promise<CachedToken> {
    const apiKey = process.env.GROWW_API_KEY;
    const apiSecret = process.env.GROWW_API_SECRET;
    if (!apiKey || !apiSecret) {
        throw new Error(
            'GROWW_API_KEY / GROWW_API_SECRET are not set — see backend/.env. ' +
            'Generate both from https://groww.in/trade-api/api-keys.'
        );
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const checksum = crypto.createHash('sha256').update(apiSecret + timestamp).digest('hex');

    const res = await fetch(`${GROWW_BASE_URL}/token/api/access`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ key_type: 'approval', checksum, timestamp }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
            `Groww login failed (${res.status}): ${body.slice(0, 300)} — ` +
            `if this is a fresh day, the key may need re-approving at https://groww.in/trade-api/api-keys`
        );
    }

    const data = await res.json();
    const token: string | undefined = data.token;
    if (!token) {
        throw new Error(`Groww login response had no token: ${JSON.stringify(data).slice(0, 300)}`);
    }

    // data.expiry (e.g. "2026-09-05T06:00:00") carries no timezone marker;
    // fall back to it only if the JWT itself can't be decoded.
    const fallback = Date.parse(data.expiry) || Date.now() + 8 * 60 * 60 * 1000;
    return { token, expiresAtMs: expiryFromJwt(token, fallback) };
}

export async function getAccessToken(): Promise<string> {
    const cached = await redisClient.get(TOKEN_CACHE_KEY);
    if (cached) {
        const parsed: CachedToken = JSON.parse(cached);
        if (parsed.expiresAtMs - REFRESH_MARGIN_MS > Date.now()) {
            return parsed.token;
        }
    }

    // Single-flight: concurrent callers during a cold start or a race at
    // expiry should trigger exactly one login, not one per caller.
    if (inFlight) return inFlight;

    inFlight = (async () => {
        try {
            const fresh = await loginWithApproval();
            const ttlSec = Math.max(30, Math.floor((fresh.expiresAtMs - Date.now()) / 1000));
            await redisClient.setEx(TOKEN_CACHE_KEY, ttlSec, JSON.stringify(fresh));
            return fresh.token;
        } finally {
            inFlight = null;
        }
    })();

    return inFlight;
}

/** Call after a 401 from a Groww API call — the cached token may have been
 * revoked server-side even though our own clock thinks it's still valid. */
export async function invalidateAccessToken(): Promise<void> {
    await redisClient.del(TOKEN_CACHE_KEY);
}

export { GROWW_BASE_URL };
