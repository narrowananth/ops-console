// Development counterpart of `ops-console open`: Vite serves the UI on 4545, the backend writes its token
// to backend/.data/runtime.json.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const runtimeFile = path.resolve(import.meta.dirname, '../backend/.data/runtime.json');
let token;
try {
  token = JSON.parse(readFileSync(runtimeFile, 'utf8')).token;
} catch {
  console.error('The backend is not running. Run `pnpm dev` first.');
  process.exit(1);
}
execFileSync('open', [`http://127.0.0.1:4545/#token=${token}`]);
