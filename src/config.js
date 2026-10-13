/** Minimal .env loader + typed config (no dotenv dependency). */
import fs from 'node:fs';
import path from 'node:path';

function loadEnvFile(file = '.env') {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) return;
  const txt = fs.readFileSync(abs, 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2].replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvFile();

export const config = {
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || '0.0.0.0',
  env: process.env.NODE_ENV || 'development',
  dbPath: process.env.DB_PATH || './data/pocket_mentor.db',
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret',
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 10) * 1024 * 1024,
  allowedExtensions: (process.env.ALLOWED_EXTENSIONS || '.txt,.md,.docx,.pdf')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  ai: {
    provider: process.env.AI_PROVIDER || 'local-engine',
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || 'gpt-4o-mini',
    baseUrl: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
  },
};
