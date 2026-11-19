#!/usr/bin/env node
// Prints ONLY structural fields for randomly sampled turns that contain an edit:
// turn index, tool labels after the last edit (in order), class, claim word matched.
// No text, paths or commands. Usage: node scripts/sample-turns.mjs [--n 50] [--seed 1] [--dir D] [--since 30d] [--claims-only]
import * as claude from '../src/adapters/claude-code.mjs';
import path from 'node:path';
import { loadSessions, parseSince } from '../src/load.mjs';
import { analyzeSegments } from '../src/metrics.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const n = +opt('--n', 50);
let seed = +opt('--seed', 1) || 1;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const dirs = opt('--dir') ? [path.resolve(opt('--dir'))] : claude.defaultDirs();
const { sessions } = loadSessions({ dirs, sinceMs: parseSince(opt('--since', '30d')), adapter: claude });
let recs = analyzeSegments(sessions);
if (args.includes('--claims-only')) recs = recs.filter((r) => r.cls);
const ids = new Map();
const sid = (s) => { if (!ids.has(s)) ids.set(s, 'S' + (ids.size + 1)); return ids.get(s); };
for (let i = recs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [recs[i], recs[j]] = [recs[j], recs[i]]; }
for (const r of recs.slice(0, n)) {
  const tools = r.tools.length > 14 ? r.tools.slice(0, 14).join(' ') + ` ...(+${r.tools.length - 14})` : r.tools.join(' ');
  console.log(`${sid(r.session)}#${r.index}  class=${(r.cls || 'no-claim').padEnd(9)} claim=${(r.claim || '-').padEnd(11)} edits=${r.editCalls}  after-last-edit: ${tools || '(none)'}`);
}
