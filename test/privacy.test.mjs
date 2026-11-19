// Privacy audit: the tool reads private logs, so these tests pin what can ever leave it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Fx } from './helpers.mjs';
import { run } from '../src/cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'apex-context.mjs');
const S = { prompt: 'SENT_PROMPT_91', answer: 'SENT_ANSWER_92', proj: 'SENT_PROJ_93', file: 'sent_file_94.js', cmd: 'SENT_CMD_95', env: 'SENT_ENV_96', out: 'SENT_TOOLOUT_97', model: 'SENT_MODEL_98', script: 'SENT_SCRIPT_99' };
const ALL = Object.values(S);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---- (a) no network or process-spawning modules in src/ ----
test('src/ imports no network modules and never spawns processes', () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.m?js$/.test(e.name)) files.push(p); } };
  walk(path.join(ROOT, 'src')); walk(path.join(ROOT, 'bin'));
  assert.ok(files.length >= 8);
  const banned = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?(?:https?|http2|net|tls|dgram|dns|dns\/promises|child_process|worker_threads|cluster|inspector|vm|repl)['"]|\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|\bnew\s+(?:WebSocket|XMLHttpRequest)\b|\bprocess\.binding\b/;
  for (const f of files) {
    const code = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.ok(!banned.test(code), `${path.relative(ROOT, f)} uses a banned module or call`);
  }
});

test('package.json has zero runtime dependencies and no install scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies || {}, {});
  for (const k of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts?.[k], undefined);
});

// ---- fixtures with sentinels everywhere ----
function claudeFixture() {
  const root = tmp('apxpriv-');
  const dir = path.join(root, '-Users-me-' + S.proj);
  fs.mkdirSync(dir);
  const fx = new Fx('sess-' + S.proj).prompt(S.prompt)
    .read(`/home/me/${S.proj}/${S.file}`, 40000)
    .edit(`/home/me/${S.proj}/${S.file}`, 'a', 'b')
    .bash(`echo ${S.cmd} ${S.env}`, S.out);
  fx.assistant([{ type: 'text', text: 'Done. ' + S.answer }], { model: S.model + '!! rm -rf /' });
  fs.writeFileSync(path.join(dir, 'sess.jsonl'), fx.toString());
  const now = Date.parse('2026-11-05T00:00:00Z');
  fs.utimesSync(path.join(dir, 'sess.jsonl'), now / 1000, now / 1000);
  return { root, dir, now };
}
const go = (args, o = {}) => { const out = [], err = []; const code = run(args, { out: (s) => out.push(s), err: (s) => err.push(s), isTTY: false, ...o }); return { code, text: out.join('\n') + '\n' + err.join('\n') }; };
const clean = (text, extra = []) => { for (const s of [...ALL, ...extra]) assert.ok(!text.includes(s), `leaked ${s}`); };

// ---- (b) every report output ----
test('report outputs (default, --json, --share, --explain, gemini, bad args) leak no sentinel, path or model junk', () => {
  const { root, now } = claudeFixture();
  try {
    for (const flags of [[], ['--json'], ['--share'], ['--explain'], ['--since', '90d'], ['--agent', 'gemini']]) {
      const r = go(['report', '--dir', root, ...flags], { now });
      clean(r.text, [root, os.tmpdir()]);
      assert.ok(!/rm -rf/.test(r.text));
    }
    for (const bad of [['report', '--dir', root, '--since', 'x'], ['report', '--prices', path.join(root, 'nope-' + S.proj + '.json'), '--dir', root], ['nope-' + S.proj], ['report', '--zzz-' + S.proj.toLowerCase()]]) {
      const r = go(bad, { now }); assert.notEqual(r.code, 0);
      assert.ok(!r.text.includes(root));
      assert.ok(!r.text.includes(S.proj + '.json'), 'error echoed a file path');
    }
    const j = JSON.parse(go(['report', '--dir', root, '--json'], { now }).text.split('\n\n')[0].replace(/\n$/, '') || '{}');
    assert.ok(Object.keys(j.spend.perModel).every((k) => /^[A-Za-z0-9._:-]{1,60}$/.test(k)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('empty-logs message names the adapter and a fixed default location, never a real folder', () => {
  const empty = tmp('apxempty-' + S.proj + '-');
  try {
    const custom = go(['report', '--dir', empty]).text;
    assert.match(custom, /No Claude Code session logs/); assert.match(custom, /folder given with --dir/);
    assert.ok(!custom.includes(S.proj) && !custom.includes(empty));
    const home = tmp('apxhome-' + S.proj + '-');
    const r = spawnSync(process.execPath, [BIN, 'report', '--agent', 'gemini'], { env: { ...process.env, HOME: home, GEMINI_CLI_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, S.proj) }, encoding: 'utf8' });
    assert.equal(r.status, 0); assert.match(r.stdout, /~\/\.gemini\/tmp/);
    assert.ok(!(r.stdout + r.stderr).includes(home));
    const c = spawnSync(process.execPath, [BIN, 'report'], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, S.proj) }, encoding: 'utf8' });
    assert.ok(!(c.stdout + c.stderr).includes(S.proj)); assert.match(c.stdout, /~\/\.claude\/projects/);
    fs.rmSync(home, { recursive: true, force: true });
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

// ---- gate outputs ----
function gateFixture({ scripts }) {
  const dir = tmp('apxg-' + S.proj + '-');
  const tp = path.join(dir, 't.jsonl');
  const fx = new Fx('sid-' + S.proj).prompt(S.prompt).edit(`${dir}/src/${S.file}`).text('All done ' + S.answer);
  fs.writeFileSync(tp, fx.toString());
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts }));
  return { dir, tp, stateDir: path.join(dir, 'state'), payload: { session_id: 'sid-' + S.proj, transcript_path: tp, cwd: dir, hook_event_name: 'Stop', prompt: S.prompt, prompt_response: S.answer } };
}
test('gate warn/block/exit2/verbose output never contains sentinels, paths or script contents', () => {
  const g = gateFixture({ scripts: { test: `echo ${S.script} && curl evil`, lint: S.script, build: S.script, secretscript: S.script } });
  try {
    for (const args of [[], ['--block'], ['--block', '--exit2'], ['--verbose'], ['--block', '--verbose', '--max-blocks', '0']]) {
      const o = [], e = [];
      const code = run(['gate', ...args], { out: (s) => o.push(s), err: (s) => e.push(s), stdin: JSON.stringify(g.payload), env: {}, stateDir: g.stateDir });
      const text = o.join('\n') + e.join('\n') + code;
      clean(text, [g.dir, os.tmpdir(), 'secretscript', 'curl', 'evil']);
      assert.ok(!text.includes(path.basename(g.dir)));
    }
    const o = []; run(['gate'], { out: (s) => o.push(s), err: () => {}, stdin: JSON.stringify(g.payload), env: {}, stateDir: g.stateDir });
    assert.match(JSON.parse(o[0]).systemMessage, /detected: npm test, npm run lint, npm run build/);
  } finally { fs.rmSync(g.dir, { recursive: true, force: true }); }
});

test('gate failing open prints only an error class, never the underlying message', () => {
  const dir = tmp('apxfo-' + S.proj + '-');
  try {
    const missing = path.join(dir, S.file + '.jsonl');
    for (const stdin of ['{' + S.prompt, JSON.stringify({ transcript_path: missing }), JSON.stringify({ transcript_path: dir })]) {
      const e = []; const code = run(['gate', '--verbose'], { out: () => {}, err: (s) => e.push(s), stdin, env: {} });
      assert.equal(code, 0);
      const t = e.join('\n'); clean(t, [dir]); assert.match(t, /failing open \([A-Za-z]+\)/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gate end to end via the real bin: stdout/stderr clean, exit 0', () => {
  const g = gateFixture({ scripts: { test: 'node --test' } });
  try {
    const r = spawnSync(process.execPath, [BIN, 'gate', '--block'], { input: JSON.stringify(g.payload), env: { ...process.env, TMPDIR: g.dir }, encoding: 'utf8' });
    assert.equal(r.status, 0);
    clean(r.stdout + r.stderr, [g.dir]);
  } finally { fs.rmSync(g.dir, { recursive: true, force: true }); }
});

// ---- (c)(d) state files ----
test('state files: hashed name, only turnKey and counter, mode 0600, dir 0700', () => {
  const g = gateFixture({ scripts: { test: 'x' } });
  try {
    run(['gate', '--block'], { out: () => {}, err: () => {}, stdin: JSON.stringify(g.payload), env: {}, stateDir: g.stateDir });
    const files = fs.readdirSync(g.stateDir); assert.equal(files.length, 1);
    assert.match(files[0], /^[0-9a-f]{32}\.json$/);
    assert.ok(!files[0].includes(S.proj));
    const f = path.join(g.stateDir, files[0]);
    const content = fs.readFileSync(f, 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(content)).sort(), ['blocks', 'turnKey']);
    clean(content, [g.dir]);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(f).mode & 0o777, 0o600);
      assert.equal(fs.statSync(g.stateDir).mode & 0o777, 0o700);
    }
  } finally { fs.rmSync(g.dir, { recursive: true, force: true }); }
});

// ---- (e) never writes into the logs it reads ----
const snapshot = (d) => { const o = {}; const w = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); if (e.isDirectory()) { o[q] = 'dir'; w(q); } else { const st = fs.statSync(q); o[q] = st.size + ':' + st.mtimeMs; } } }; w(d); return o; };
test('report and gate never write into the logs folder they read', () => {
  const { root, dir, now } = claudeFixture();
  try {
    const before = snapshot(root);
    for (const flags of [[], ['--json'], ['--share']]) go(['report', '--dir', root, ...flags], { now });
    run(['gate', '--block'], { out: () => {}, err: () => {}, stdin: JSON.stringify({ transcript_path: path.join(dir, 'sess.jsonl'), cwd: dir, session_id: 'x' }), env: {}, stateDir: path.join(tmp('apxst-'), 's') });
    assert.deepEqual(snapshot(root), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- install-hook output and permissions ----
test('install-hook dry run prints only its own entry, not the rest of the settings; write keeps file mode', () => {
  const dir = tmp('apxih-'); const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ env: { TOKEN: S.env }, model: S.model }), { mode: 0o640 });
  try {
    const r = go(['install-hook', '--settings', file]);
    clean(r.text); assert.ok(!r.text.includes('"env"')); assert.match(r.text, /Stop/);
    go(['install-hook', '--settings', file, '--write']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).env.TOKEN, S.env);
    const bad = path.join(dir, 'bad-' + S.proj + '.json'); fs.writeFileSync(bad, '{x');
    const e = go(['install-hook', '--settings', bad, '--write']); assert.equal(e.code, 1); assert.ok(!e.text.includes(S.proj));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- (f) uncaught errors ----
test('bin: an unexpected error prints a generic line plus the class, never the message', () => {
  const dir = tmp('apxerr-');
  const loader = path.join(dir, 'boom.mjs');
  fs.writeFileSync(loader, `import { register } from 'node:module'; register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(`export async function load(u,c,n){ if(u.endsWith('/src/cli.mjs')) return {format:'module',shortCircuit:true,source:'export function run(){ throw new TypeError("${S.prompt} /secret/${S.proj}"); }'}; return n(u,c); }`)}), import.meta.url);`);
  try {
    const r = spawnSync(process.execPath, ['--import', loader, BIN, 'report'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unexpected error \(TypeError\)/);
    clean(r.stdout + r.stderr);
    assert.ok(!/\bat \S+ \(|\.mjs:\d+/.test(r.stderr), 'no stack trace');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- scripts ----
test('scripts print aggregates only (no sentinels)', () => {
  const { root } = claudeFixture();
  try {
    for (const [s, args] of [['replay-gate.mjs', ['--dir', root, '--since', '3650d']], ['sample-turns.mjs', ['--dir', root, '--since', '3650d', '--n', '5']]]) {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', s), ...args], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      clean(r.stdout + r.stderr, [root]);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- packaging ----
test('npm pack file list contains only the intended files', () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const names = JSON.parse(r.stdout)[0].files.map((f) => f.path).sort();
  for (const n of names) assert.ok(/^(bin\/|src\/|docs\/|LICENSE$|README\.md$|CHANGELOG\.md$|SECURITY\.md$|CONTRIBUTING\.md$|package\.json$)/.test(n), 'unexpected packed file ' + n);
  for (const need of ['bin/apex-context.mjs', 'src/cli.mjs', 'src/prices.json', 'LICENSE', 'README.md', 'package.json']) assert.ok(names.includes(need), 'missing ' + need);
});

test('CLI usage: no command and --help print help (exit 0), --version, bad usage is non-zero', () => {
  const sp = (...a) => spawnSync(process.execPath, [BIN, ...a], { encoding: 'utf8' });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(sp().status, 0); assert.match(sp().stdout, /Commands/);
  assert.match(sp('--help').stdout, /report .*install-hook/s);
  assert.equal(sp('--version').stdout.trim(), pkg.version);
  for (const c of ['report', 'gate', 'install-hook', 'uninstall-hook']) { const h = sp(c, '--help'); assert.equal(h.status, 0); assert.match(h.stdout, new RegExp('apex-context ' + c)); }
  assert.match(sp('help', 'gate').stdout, /apex-context gate/);
  assert.equal(sp('bogus').status, 2); assert.equal(sp('report', '--nope').status, 2); assert.equal(sp('report', '--dir').status, 2);
});
