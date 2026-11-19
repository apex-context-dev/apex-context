// Runs every test/**/*.test.* file. An explicit file list keeps `node --test` from also
// picking up the benchmark example tasks' hidden tests (which are meant to fail on the unsolved project).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.test\.m?js$/.test(e.name)) files.push(p); } };
walk(path.join(root, 'test'));
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files.sort()], { stdio: 'inherit', cwd: root });
process.exit(r.status ?? 1);
