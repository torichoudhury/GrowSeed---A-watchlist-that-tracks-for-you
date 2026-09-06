import jwt from 'jsonwebtoken';

export interface AuthedRequest {
    user?: { id: string; email: string };
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is not set — required to sign/verify session tokens');
}

export interface TokenPayload {
    sub: string;
    email: string;
}

export function signToken(payload: TokenPayload): string {
    return jwt.sign(payload, JWT_SECRET as string, {
        expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as jwt.SignOptions['expiresIn'],
    });
}

/** Verifies `Authorization: Bearer <token>` and attaches req.user. 401 on any failure. */
export function requireAuth(req: any, res: any, next: any) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }

    const token = header.slice('Bearer '.length);
    try {
        const decoded = jwt.verify(token, JWT_SECRET as string) as jwt.JwtPayload;
        if (!decoded.sub || typeof decoded.sub !== 'string') {
            return res.status(401).json({ error: 'Invalid token' });
        }
        req.user = { id: decoded.sub, email: decoded.email };
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

/** Same verification, but for the WebSocket handshake (token arrives as a query param, not a header). */
export function verifyToken(token: string): TokenPayload | null {
    try {
        const decoded = jwt.verify(token, JWT_SECRET as string) as jwt.JwtPayload;
        if (!decoded.sub || typeof decoded.sub !== 'string') return null;
        return { sub: decoded.sub, email: decoded.email };
    } catch {
        return null;
    }
}
