import fs from 'node:fs';
import path from 'node:path';
import { pool, query } from './config/db';

/**
 * `npm run migrate -- 003_horizons_and_adjustment_guard.sql`
 *
 * Applies ONE named migration file from ../migrations inside a transaction and
 * records it in schema_migrations so a second run is a no-op. The filename is
 * required on purpose: the early migrations were applied by hand before this
 * runner existed, so nothing here should ever decide for itself which files
 * are outstanding.
 */

const file = process.argv[2];
if (!file) {
    console.error('Usage: npm run migrate -- <filename.sql>   (files live in ./migrations)');
    process.exit(1);
}

async function main() {
    const full = path.resolve(__dirname, '..', '..', 'migrations', file);
    if (!fs.existsSync(full)) throw new Error(`No such migration: ${full}`);
    const sql = fs.readFileSync(full, 'utf8');

    await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

    const already = await query('SELECT applied_at FROM schema_migrations WHERE filename = $1', [file]);
    if (already.rows.length > 0) {
        console.log(`${file} was already applied at ${already.rows[0].applied_at.toISOString()} — nothing to do.`);
        return;
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`Applied ${file}.`);
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

main()
    .catch(err => { console.error('Migration failed:', err.message); process.exitCode = 1; })
    .finally(async () => { await pool.end(); });
