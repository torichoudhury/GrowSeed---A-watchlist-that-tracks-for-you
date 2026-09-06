import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error("No DATABASE_URL in .env");
    
    // Supabase requires SSL
    const client = new Client({
        connectionString: dbUrl,
        ssl: { rejectUnauthorized: false }
    });

    try {
        await client.connect();
        console.log("Connected to Supabase Postgres.");

        const sql = fs.readFileSync(path.join(__dirname, '../migrations/001_initial_schema.sql'), 'utf-8');
        
        console.log("Running migration...");
        await client.query(sql);
        console.log("Migration successful!");
    } catch (e) {
        console.error("Migration failed:", e);
        process.exit(1);
    } finally {
        await client.end();
    }
}

run();
