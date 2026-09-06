import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../config/db';
import { signToken } from '../middleware/auth';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS = 10;

function publicUser(row: { id: string; email: string }) {
    return { id: row.id, email: row.email };
}

router.post('/register', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!EMAIL_RE.test(email)) {
        return res.status(400).json({ error: 'Enter a valid email address' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    try {
        const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'An account with that email already exists' });
        }

        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const userRes = await query(
            'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
            [email, passwordHash]
        );
        const user = userRes.rows[0];

        // A brand-new account with an empty watchlist screen is a dead end —
        // seed one default list so the dashboard has somewhere to land.
        await query('INSERT INTO watchlists (user_id, name) VALUES ($1, $2)', [user.id, 'My Watchlist']);

        const accessToken = signToken({ sub: user.id, email: user.email });
        res.status(201).json({ accessToken, user: publicUser(user) });
    } catch (e) {
        console.error('Register failed:', e);
        res.status(500).json({ error: 'Could not create account' });
    }
});

router.post('/login', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        const result = await query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const accessToken = signToken({ sub: user.id, email: user.email });
        res.json({ accessToken, user: publicUser(user) });
    } catch (e) {
        console.error('Login failed:', e);
        res.status(500).json({ error: 'Could not log in' });
    }
});

export default router;
