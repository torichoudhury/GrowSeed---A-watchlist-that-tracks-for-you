/**
 * NSE India public JSON endpoints — corporate actions, results calendar,
 * announcements. Undocumented and unofficial (approved for use 2026-09-04):
 * polled gently, once a day per watched symbol, results cached in Postgres.
 * Requires browser-like headers; a cookie handshake is attempted only if a
 * direct call is refused.
 */

const NSE_BASE = 'https://www.nseindia.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const POLITE_DELAY_MS = 400;

let cookieHeader: string | null = null;

async function refreshCookies(): Promise<void> {
    try {
        const res = await fetch(`${NSE_BASE}/`, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' } });
        const setCookies = (res.headers as any).getSetCookie?.() as string[] | undefined;
        if (setCookies && setCookies.length > 0) {
            cookieHeader = setCookies.map(c => c.split(';')[0]).join('; ');
        }
    } catch {
        // Handshake is best-effort; direct calls have worked without it.
    }
}

export async function nseGet(path: string, referer: string): Promise<any> {
    const doFetch = () => fetch(`${NSE_BASE}${path}`, {
        headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
            Referer: `${NSE_BASE}${referer}`,
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
    });

    let res = await doFetch();
    if (res.status === 401 || res.status === 403) {
        await refreshCookies();
        res = await doFetch();
    }
    if (!res.ok) {
        throw new Error(`NSE ${path} -> ${res.status}`);
    }
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`NSE ${path} returned non-JSON (${text.slice(0, 80)}...)`);
    }
}

export const politeDelay = () => new Promise(r => setTimeout(r, POLITE_DELAY_MS));

export interface NseCorporateAction {
    symbol: string;
    comp: string;
    subject: string;
    exDate: string;   // DD-Mon-YYYY
    recDate: string;
    faceVal: string;
    series: string;
}

export interface NseEvent {
    symbol: string;
    company: string;
    purpose: string;
    bm_desc: string;
    date: string;     // DD-Mon-YYYY
}

export interface NseAnnouncement {
    symbol: string;
    desc: string;
    attchmntText: string;
    an_dt: string;       // DD-Mon-YYYY HH:mm:ss
    smIndustry: string | null;
}

export function fetchCorporateActions(symbol: string): Promise<NseCorporateAction[]> {
    return nseGet(
        `/api/corporates-corporateActions?index=equities&symbol=${encodeURIComponent(symbol)}`,
        '/companies-listing/corporate-filings-actions'
    );
}

export function fetchEventCalendar(symbol: string): Promise<NseEvent[]> {
    return nseGet(
        `/api/event-calendar?index=equities&symbol=${encodeURIComponent(symbol)}`,
        '/companies-listing/corporate-filings-event-calendar'
    );
}

export function fetchAnnouncements(symbol: string): Promise<NseAnnouncement[]> {
    return nseGet(
        `/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(symbol)}`,
        '/companies-listing/corporate-filings-announcements'
    );
}

/** NSE dates are "05-Jun-2026"; JS Date.parse is not reliable for that form. */
const MONTHS: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
export function parseNseDate(value: string | null | undefined): string | null {
    if (!value || value === '-') return null;
    const m = value.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
    if (!m) return null;
    const month = MONTHS[m[2].toLowerCase()];
    if (month === undefined) return null;
    const d = new Date(Date.UTC(Number(m[3]), month, Number(m[1])));
    return d.toISOString().slice(0, 10);
}
