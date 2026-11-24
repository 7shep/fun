// Vercel build step: write config.js from env vars (the real config.js is gitignored).
import { writeFileSync } from 'node:fs';

const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  writeFileSync('config.js', `window.LCL_CONFIG = ${JSON.stringify({ SUPABASE_URL, SUPABASE_ANON_KEY })};\n`);
  console.log('Wrote config.js');
} else {
  console.log('SUPABASE_URL / SUPABASE_ANON_KEY not set; leaving config.js as is');
}
