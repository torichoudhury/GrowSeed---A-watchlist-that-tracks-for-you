/**
 * Log redaction.
 *
 * Errors from an upstream API carry whatever that API sent back, and one of
 * ours stringified an entire auth response into its message — so a renamed
 * token field would have printed a live bearer token into the log verbatim.
 * Everything that logs an error object or a config value goes through here.
 *
 * The rule is shape-based, not name-based where it can be: a JWT looks like a
 * JWT wherever it appears, including inside a URL or a JSON blob.
 */

const SECRET_KEY_RE = /(("|')?(?:\w*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|checksum)\w*)("|')?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const CONNECTION_URL_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^:/@\s]+):([^@\s]+)@/gi;
const QUERY_SECRET_RE = /([?&](?:token|ticket|key|secret|password|sig|signature)=)([^&\s"']+)/gi;

export const MASK = '[redacted]';

/** Mask secrets in a single string. */
export function redactString(value: string): string {
    return value
        .replace(JWT_RE, MASK)
        .replace(BEARER_RE, (_m, scheme) => `${scheme} ${MASK}`)
        .replace(CONNECTION_URL_RE, (_m, scheme, user) => `${scheme}${user}:${MASK}@`)
        .replace(QUERY_SECRET_RE, (_m, prefix) => `${prefix}${MASK}`)
        .replace(SECRET_KEY_RE, (_m, prefix) => `${prefix}${MASK}`);
}

/**
 * Mask secrets anywhere in a value. Errors keep their name, message and stack
 * (all redacted) because losing the stack to protect a token nobody logged is
 * a bad trade.
 */
export function redact(value: unknown, depth = 0): unknown {
    if (depth > 4) return '[depth limit]';
    if (typeof value === 'string') return redactString(value);
    if (value === null || value === undefined || typeof value !== 'object') return value;

    if (value instanceof Error) {
        return {
            name: value.name,
            message: redactString(value.message),
            stack: value.stack ? redactString(value.stack) : undefined,
        };
    }
    if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = /token|secret|password|passwd|api[_-]?key|authorization|cookie|checksum/i.test(k)
            ? MASK
            : redact(v, depth + 1);
    }
    return out;
}

/**
 * Describe a payload without disclosing it: its keys and each value's type.
 * For "the response didn't have the field I expected" errors, this is the
 * information you actually need, and none of the information you must not log.
 */
export function describeShape(value: unknown): string {
    if (value === null || value === undefined) return String(value);
    if (Array.isArray(value)) return `array(${value.length})`;
    if (typeof value !== 'object') return typeof value;
    return `{ ${Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? `array(${v.length})` : typeof v}`)
        .join(', ')} }`;
}
