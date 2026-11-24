// One-time: create the tables. Usage: node --env-file=.env.local scripts/setup-db.mjs
import { neon } from '@neondatabase/serverless';
import { SCHEMA } from '../api/room.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (vercel env pull .env.local)');
const sql = neon(process.env.DATABASE_URL);
for (const stmt of SCHEMA) await sql.query(stmt);
console.log('Tables ready:', (await sql`select table_name from information_schema.tables where table_name like 'lcl_%' order by 1`).map((r) => r.table_name).join(', '));
