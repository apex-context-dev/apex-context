import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Fx } from './helpers.mjs';
import { run } from '../src/cli.mjs';
import { addHook, removeHook } from '../src/hooks.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apxgate-'));
function setup(fx, extra = {}) {
  const dir = tmp();
  const tp = path.join(dir, 't.jsonl');
  fs.writeFileSync(tp, fx.toString());
  if (!extra.noRunner) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  delete extra.noRunner;
  return { dir, tp, stateDir: path.join(dir, 'state'), payload: { session_id: 'sess-1', transcript_path: tp, stop_hook_active: false, hook_event_name: 'Stop', cwd: dir, ...extra } };
}
function gate(s, args = [], { payload = s.payload, stdin, env = {}, warn = false } = {}) {
  const o = [], e = [];
  const code = run(['gate', ...(warn ? [] : ['--block']), ...args], { out: (x) => o.push(x), err: (x) => e.push(x), stdin: stdin ?? JSON.stringify(payload), env, stateDir: s.stateDir });
  return { code, out: o.join('\n'), err: e.join('\n') };
}
const F = 'src/a.js';
const editOnly = () => new Fx('s').prompt().edit(F).text('All done.');
const blocked = (r) => r.code === 0 && JSON.parse(r.out).decision === 'block';
const silent = (r) => r.code === 0 && r.out === '' && r.err === '';

test('no edits: allow silently', () => {
  const s = setup(new Fx('s').prompt().read(F).text('Here is the answer.'));
  assert.ok(silent(gate(s)));
});

test('edit + passing test: allow; verbose prints one line to stderr only', () => {
  const s = setup(new Fx('s').prompt().edit(F).bash('npm test', 'ok').text('Done.'));
  assert.ok(silent(gate(s)));
  const v = gate(s, ['--verbose']);
  assert.equal(v.code, 0); assert.equal(v.out, ''); assert.match(v.err, /verified \(PROVEN\)/);
});

test('edit + no check: block with the runner guess', () => {
  const s = setup(editOnly());
  fs.writeFileSync(path.join(s.dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }));
  const r = gate(s);
  assert.ok(blocked(r));
  const reason = JSON.parse(r.out).reason;
  assert.match(reason, /nothing ran after the last edit/);
  assert.match(reason, /npm test, npm run lint/);
  assert.equal(r.err, '');
});

test('--exit2 blocks with exit code 2 and the reason on stderr', () => {
  const s = setup(editOnly());
  const r = gate(s, ['--exit2']);
  assert.equal(r.code, 2); assert.equal(r.out, ''); assert.match(r.err, /nothing ran/);
});

test('edit + failing test: block, naming the check kind', () => {
  const s = setup(new Fx('s').prompt().edit(F).bash('npx tsc --noEmit', 'Exit code 2\nerror TS1', true).text('Done.'));
  const r = gate(s);
  assert.ok(blocked(r));
  assert.match(JSON.parse(r.out).reason, /last typecheck check/);
  const s2 = setup(new Fx('s').prompt().edit(F).bash('pytest -q', 'Exit code 1\n1 failed', true).text('Done.'));
  assert.match(JSON.parse(gate(s2).out).reason, /last test check/);
});

test('a later passing test after a failing one is PROVEN', () => {
  const s = setup(new Fx('s').prompt().edit(F).bash('npm test', 'Exit code 1', true).edit(F).bash('npm test', 'ok').text('Done.'));
  assert.ok(silent(gate(s)));
});

test('only checks AFTER the last edit count', () => {
  const s = setup(new Fx('s').prompt().bash('npm test', 'ok').edit(F).text('Done.'));
  assert.ok(blocked(gate(s)));
});

test('manual check: allow by default, block with --strict, --allow-manual overrides', () => {
  const s = setup(new Fx('s').prompt().edit(F).bash('node scripts/try.js', 'ok').text('Done.'));
  assert.ok(silent(gate(s)));
  assert.ok(blocked(gate(s, ['--strict'])));
  assert.ok(silent(gate(s, ['--strict', '--allow-manual'])));
});

test('Bash edit counts as an edit', () => {
  const s = setup(new Fx('s').prompt().bash("sed -i 's/a/b/' src/a.js").text('Done.'));
  assert.ok(blocked(gate(s)));
});

test('stop_hook_active allows with a final unverified note', () => {
  const s = setup(editOnly());
  const r = gate(s, [], { payload: { ...s.payload, stop_hook_active: true } });
  assert.equal(r.code, 0); assert.equal(r.out, ''); assert.match(r.err, /unverified/);
  // and a verified turn stays silent even then
  const ok = setup(new Fx('s').prompt().edit(F).bash('npm test').text('Done.'));
  assert.ok(silent(gate(ok, [], { payload: { ...ok.payload, stop_hook_active: true } })));
});

test('two prior blocks in the same turn, then allow; a new turn resets', () => {
  const fx = editOnly();
  const s = setup(fx);
  assert.ok(blocked(gate(s)));
  assert.ok(blocked(gate(s)));
  const third = gate(s);
  assert.equal(third.out, ''); assert.match(third.err, /unverified/);
  // new user prompt with another unverified edit: blocks again
  fx.prompt('next').edit(F).text('Done.');
  fs.writeFileSync(s.tp, fx.toString());
  assert.ok(blocked(gate(s)));
  // --max-blocks 1
  const s2 = setup(editOnly());
  assert.ok(blocked(gate(s2, ['--max-blocks', '1'])));
  assert.match(gate(s2, ['--max-blocks', '1']).err, /unverified/);
});

test('hook feedback message does not start a new turn', () => {
  const fx = editOnly();
  fx.raw({ type: 'user', sessionId: 's', timestamp: new Date(Date.parse('2026-11-01T11:00:00Z')).toISOString(), message: { role: 'user', content: 'Stop hook feedback: Code was edited...' } });
  fx.text('I still think it is done.');
  const s = setup(fx);
  assert.ok(blocked(gate(s)));
});

test('state files are isolated per session', () => {
  const s = setup(editOnly());
  assert.ok(blocked(gate(s))); assert.ok(blocked(gate(s)));
  const other = { ...s, payload: { ...s.payload, session_id: 'sess-2' } };
  assert.ok(blocked(gate(other)));
  assert.equal(fs.readdirSync(s.stateDir).length, 2);
  const evil = { ...s, payload: { ...s.payload, session_id: '../../evil' } };
  gate(evil);
  assert.ok(fs.readdirSync(s.stateDir).every((f) => !f.includes('/')));
  assert.equal(fs.existsSync(path.join(s.stateDir, '..', '..', 'evil.json')), false);
});

test('fail open: bad JSON, missing transcript, garbage transcript, empty stdin, bad flag', () => {
  const s = setup(editOnly());
  for (const stdin of ['{nope', '', 'null', '[]', JSON.stringify({ transcript_path: '/nonexistent/x.jsonl' }), JSON.stringify({ session_id: 'x' })]) {
    assert.ok(silent(gate(s, [], { stdin })), stdin);
  }
  const g = setup(new Fx('s')); fs.writeFileSync(g.tp, 'garbage\n{"a":\n');
  assert.ok(silent(gate(g)));
  const v = gate(s, ['--verbose'], { stdin: '{nope' });
  assert.equal(v.code, 0); assert.match(v.err, /failing open/);
  assert.ok(silent(gate(s, ['--max-blocks', 'x'])));
});

test('APEX_CONTEXT_GATE=off disables', () => {
  const s = setup(editOnly());
  assert.ok(silent(gate(s, [], { env: { APEX_CONTEXT_GATE: 'off' } })));
});

test('gate --explain prints the rules', () => {
  const o = []; const code = run(['gate', '--explain'], { out: (x) => o.push(x) });
  assert.equal(code, 0); assert.match(o.join(''), /Fails open/);
});

test('performance guard: large synthetic transcript is read tail-first', () => {
  const dir = tmp(); const tp = path.join(dir, 'big.jsonl');
  const fx = new Fx('s');
  fx.prompt('old');
  for (let i = 0; i < 400; i++) fx.edit(F).bash('npm test');
  const chunk = fx.toString();
  const fd = fs.openSync(tp, 'w');
  const reps = Math.ceil(30e6 / chunk.length);
  for (let i = 0; i < reps; i++) fs.writeSync(fd, chunk);
  const tail = new Fx('s').prompt('now').edit(F).text('Done.');
  fs.writeSync(fd, tail.toString()); fs.closeSync(fd);
  assert.ok(fs.statSync(tp).size > 25e6);
  const s = { dir, tp, stateDir: path.join(dir, 'st'), payload: { session_id: 'big', transcript_path: tp, cwd: dir } };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
  const t0 = process.hrtime.bigint();
  const r = gate(s);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(blocked(r));
  assert.ok(ms < 300, `took ${ms}ms`);
});

test('install-hook: dry run changes nothing; --write merges, keeps other hooks, idempotent; uninstall reverses', () => {
  const dir = tmp(); const file = path.join(dir, 'settings.json');
  const original = { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint' }] }] } };
  fs.writeFileSync(file, JSON.stringify(original));
  const go = (args) => { const o = [], e = []; const code = run(args, { out: (x) => o.push(x), err: (x) => e.push(x), cwd: dir }); return { code, text: o.join('\n'), err: e.join('\n') }; };
  const dry = go(['install-hook', '--settings', file]);
  assert.equal(dry.code, 0); assert.match(dry.text, /Dry run/); assert.match(dry.text, new RegExp(file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
  go(['install-hook', '--settings', file, '--write', '--dry-run']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
  go(['install-hook', '--settings', file, '--write']);
  const a = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(a.model, 'x'); assert.deepEqual(a.hooks.PreToolUse, original.hooks.PreToolUse);
  assert.equal(a.hooks.Stop.length, 2); assert.equal(a.hooks.Stop[0].hooks[0].command, 'echo mine');
  assert.match(a.hooks.Stop[1].hooks[0].command, /apex-context\.mjs" gate$/);
  const again = go(['install-hook', '--settings', file, '--write']);
  assert.match(again.text, /Already installed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), a);
  go(['uninstall-hook', '--settings', file, '--write']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
});

test('install-hook: default target is <cwd>/.claude/settings.json, user target under CLAUDE_CONFIG_DIR; invalid JSON refused', () => {
  const dir = tmp();
  const o = []; run(['install-hook'], { out: (x) => o.push(x), cwd: dir });
  assert.ok(o.join('\n').includes(path.join(dir, '.claude', 'settings.json')));
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
  const o2 = []; run(['install-hook', '--user'], { out: (x) => o2.push(x), cwd: dir, env: { CLAUDE_CONFIG_DIR: path.join(dir, 'cfg') } });
  assert.ok(o2.join('\n').includes(path.join(dir, 'cfg', 'settings.json')));
  const bad = path.join(dir, 'bad.json'); fs.writeFileSync(bad, '{x');
  const e = []; assert.equal(run(['install-hook', '--settings', bad, '--write'], { out: () => {}, err: (x) => e.push(x) }), 1);
  assert.equal(fs.readFileSync(bad, 'utf8'), '{x');
});

test('addHook/removeHook are pure', () => {
  const s = { hooks: { Stop: [] } };
  const r = addHook(s, 'node "/x/apex-context.mjs" gate');
  assert.deepEqual(s, { hooks: { Stop: [] } });
  assert.equal(r.changed, true);
  assert.equal(removeHook(r.settings).changed, true);
});

test('default mode WARNs: stop allowed, systemMessage on stdout, exit 0; --block restores blocking', () => {
  const s = setup(editOnly());
  const w = gate(s, [], { warn: true });
  assert.equal(w.code, 0); assert.equal(w.err, '');
  const j = JSON.parse(w.out);
  assert.match(j.systemMessage, /nothing ran after the last edit/); assert.equal(j.decision, undefined);
  assert.equal(fs.existsSync(s.stateDir), false); // warn mode keeps no state
  assert.ok(blocked(gate(s)));
  assert.ok(blocked(gate(s, [], { warn: true, env: { APEX_CONTEXT_GATE_MODE: 'block' } })));
  const f = setup(new Fx('s').prompt().edit(F).bash('npm test', 'Exit code 1', true).text('Done.'));
  assert.match(JSON.parse(gate(f, [], { warn: true }).out).systemMessage, /last test check/);
  const ok = setup(new Fx('s').prompt().edit(F).bash('npm test').text('Done.'));
  assert.ok(silent(gate(ok, [], { warn: true })));
});

const out_of_scope = (name, fx, extra) => test('scope: ' + name + ' never warns or blocks', () => {
  const s = setup(fx, extra);
  assert.ok(silent(gate(s)));
  assert.ok(silent(gate(s, [], { warn: true })));
});
out_of_scope('docs-only edits', new Fx('s').prompt().edit('README.md').edit('docs/guide.txt').text('Done.'));
out_of_scope('config-only edits', new Fx('s').prompt().edit('package.json').edit('.github/ci.yaml').edit('pyproject.toml').edit('package-lock.json').text('Done.'));
out_of_scope('test-file-only edits', new Fx('s').prompt().edit('src/a.test.js').edit('test/b.mjs').edit('pkg/test_x.py').edit('x/y_test.go').text('Done.'));
out_of_scope('no-runner project', editOnly(), { noRunner: true });
out_of_scope('scratch edits', new Fx('s').prompt().edit('/tmp/x/scratch.js').edit('/private/tmp/claude-1/scratchpad/y.py').text('Done.'));
out_of_scope('shell script edits', new Fx('s').prompt().edit('run.sh').text('Done.'));

test('scope: mixed code + docs still counts; docs edited after code do not hide it', () => {
  const s = setup(new Fx('s').prompt().edit('src/a.ts').edit('README.md').text('Done.'));
  assert.ok(blocked(gate(s)));
  const t = setup(new Fx('s').prompt().edit('src/a.ts').bash('npm test').edit('README.md').text('Done.'));
  assert.ok(silent(gate(t)));
});

test('scope: Bash edit of a source file counts; of a doc does not', () => {
  assert.ok(blocked(gate(setup(new Fx('s').prompt().bash("sed -i 's/a/b/' src/a.py").text('Done.')))));
  assert.ok(silent(gate(setup(new Fx('s').prompt().bash("sed -i 's/a/b/' README.md").text('Done.')))));
});

test('runner detection: pyproject without pytest is no runner; Cargo.toml and Makefile are', () => {
  const s = setup(editOnly(), { noRunner: true });
  fs.writeFileSync(path.join(s.dir, 'pyproject.toml'), '[project]\nname="x"\n');
  assert.ok(silent(gate(s)));
  fs.writeFileSync(path.join(s.dir, 'Makefile'), 'test:\n\techo hi\n');
  assert.match(JSON.parse(gate(s).out).reason, /make test/);
  const c = setup(editOnly(), { noRunner: true });
  fs.writeFileSync(path.join(c.dir, 'Cargo.toml'), '[package]\n');
  assert.match(JSON.parse(gate(c).out).reason, /cargo test/);
});

test('runner is also found above the edited file (agent started in a parent folder)', () => {
  const s = setup(editOnly(), { noRunner: true });
  const sub = path.join(s.dir, 'app'); fs.mkdirSync(path.join(sub, 'src'), { recursive: true });
  fs.writeFileSync(path.join(sub, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
  const t = setup(new Fx('s').prompt().edit('app/src/a.js').text('Done.'), { noRunner: true });
  fs.copyFileSync(t.tp, s.tp);
  assert.match(JSON.parse(gate(s).out).reason, /npm test/);
});
