import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = process.env.DB_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'db.json');

function load() {
  if (!fs.existsSync(FILE)) return { jobs: [], cvVersions: [] };
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

export const db = load();

export function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}
