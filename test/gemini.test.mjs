import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run } from '../src/cli.mjs';
import { parseSession } from '../src/adapters/gemini-cli.mjs';
import { resolveAgent, evaluateCalls, callsOf, loadCurrentTurn } from '../src/gate.mjs';
import * as gemini from '../src/adapters/gemini-cli.mjs';

// Synthetic Gemini CLI session (one JSON document). Shape per README "Gemini CLI". No real data.
class GFx {
  constructor() { this.messages = []; this.t = Date.parse('2026-11-01T10:00:00Z'); }
  ts() { this.t += 1000; return new Date(this.t).toISOString(); }
  prompt(text = 'do the thing') { this.messages.push({ id: 'u' + this.messages.length, timestamp: this.ts(), type: 'user', content: [{ text }] }); return this; }
  gem(content, toolCalls) {
    const m = { id: 'g' + this.messages.length, timestamp: this.ts(), type: 'gemini', content, model: 'gemini-3-flash-preview', tokens: { input: 1000, output: 10, cached: 600, thoughts: 5, tool: 0, total: 1015 } };
    if (toolCalls) m.toolCalls = toolCalls;
    this.messages.push(m); return this;
  }
  call(name, args, output = 'ok', status = 'success') {
    const id = 'call_' + this.messages.length;
    return { id, name, args, status, timestamp: this.ts(), result: [{ functionResponse: { id, name, response: { output } } }] };
  }
  edit(file) { return this.gem('editing', [this.call('replace', { file_path: file, old_string: 'a', new_string: 'b', instruction: 'x' }, 'Successfully modified file')]); }
  write(file) { return this.gem('writing', [this.call('write_file', { file_path: file, content: 'x' })]); }
  sh(command, output = 'ok', exit = 0) {
    const out = exit ? `Output: ${output}\nExit Code: ${exit}` : `Output: ${output}`;
    return this.gem('running', [this.call('run_shell_command', { command }, out)]);
  }
  text(t) { return this.gem(t); }
  toString() { return JSON.stringify({ sessionId: 'sess-g', projectHash: 'h', startTime: 'x', lastUpdated: 'y', kind: 'main', messages: this.messages }, null, 2); }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apxgem-'));
function setup(fx, { runner = true } = {}) {
  const dir = tmp();
  const chats = path.join(dir, 'home', 'chats'); fs.mkdirSync(chats, { recursive: true });
  const tp = path.join(chats, 'session-2026-11-01T10-00-abcd1234.json');
  fs.writeFileSync(tp, fx.toString());
  if (runner) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  return { dir, tp, stateDir: path.join(dir, 'state'), payload: { session_id: 'g-sess', transcript_path: tp, cwd: dir, hook_event_name: 'AfterAgent', timestamp: 'x', prompt: 'p', prompt_response: 'r', stop_hook_active: false } };
}
function gate(s, args = [], { payload = s.payload, stdin, warn = false } = {}) {
  const o = [], e = [];
  const code = run(['gate', ...(warn ? [] : ['--block']), ...args], { out: (x) => o.push(x), err: (x) => e.push(x), stdin: stdin ?? JSON.stringify(payload), env: {}, stateDir: s.stateDir });
  return { code, out: o.join('\n'), err: e.join('\n') };
}
const F = 'src/a.js';
const denied = (r) => r.code === 0 && JSON.parse(r.out).decision === 'deny';
const silent = (r) => r.code === 0 && r.out === '' && r.err === '';

test('adapter: normalizes turns, tool kinds, files, exit status, usage', () => {
  const fx = new GFx().prompt('go').gem('reading', [new GFx().call('read_file', { file_path: F }, 'content')])
    .edit('/p/src/a.js').sh('npm test', 'boom', 1).sh('npm test', 'fine').text('done');
  const s = parseSession(fx.toString(), { file: 'f' });
  assert.equal(s.id, 'sess-g');
  assert.equal(s.turns[0].role, 'user'); assert.ok(s.turns[0].isPrompt);
  const calls = s.turns.flatMap((t) => t.toolCalls);
  assert.deepEqual(calls.map((c) => c.kind), ['read', 'edit', 'bash', 'bash']);
  assert.equal(calls[1].file, '/p/src/a.js');
  assert.equal(calls[2].result.exitCode, 1); assert.equal(calls[3].result.exitCode, 0);
  assert.deepEqual(s.turns[1].usage, { input: 400, cacheRead: 600, cacheCreate: 0, output: 15 });
  assert.equal(s.turns.at(-1).textTail, 'done');
});

test('adapter: calls that never ran (tool not offered, cancelled) are dropped, so they cannot prove or fail anything', () => {
  const fx = new GFx().prompt().edit(F);
  fx.gem('try', [fx.call('run_shell_command', { command: 'npm test' }, 'Tool "run_shell_command" not found. Did you mean one of: "x"?', 'error')]);
  fx.gem('try', [fx.call('run_shell_command', { command: 'npm test' }, 'denied', 'cancelled')]).text('done');
  const s = setup(fx);
  assert.equal(parseSession(fx.toString()).turns.flatMap((t) => t.toolCalls).length, 1);
  const r = gate(s); assert.ok(denied(r)); assert.match(JSON.parse(r.out).reason, /nothing ran/);
});

test('adapter: garbage and wrong shapes are malformed, never fatal', () => {
  for (const t of ['', 'not json', '[]', '{"messages":5}']) {
    const s = parseSession(t); assert.equal(s.turns.length, 0); assert.equal(s.stats.malformed, 1);
  }
  assert.equal(parseSession('{"messages":[null,{"type":"info"}]}').stats.skipped, 1);
});

test('agent detection from payload shape; explicit --agent wins', () => {
  assert.equal(resolveAgent('auto', { hook_event_name: 'AfterAgent' }), 'gemini');
  assert.equal(resolveAgent(null, { prompt_response: '', transcript_path: '/x/y.json' }), 'gemini');
  assert.equal(resolveAgent('auto', { hook_event_name: 'Stop', transcript_path: '/x/y.jsonl' }), 'claude');
  assert.equal(resolveAgent('gemini', { hook_event_name: 'Stop' }), 'gemini');
  assert.equal(resolveAgent('claude', { hook_event_name: 'AfterAgent' }), 'claude');
  assert.throws(() => resolveAgent('nope', {}));
  assert.ok(gemini.matchFile('session-1.json', '/h/tmp/p/chats/session-1.json'));
  assert.ok(!gemini.matchFile('logs.json', '/h/tmp/p/logs.json'));
});

test('gemini ALLOW: no edits; edit + passing test (PROVEN, verbose line only on stderr)', () => {
  assert.ok(silent(gate(setup(new GFx().prompt().text('Here is the answer.')))));
  const s = setup(new GFx().prompt().edit(F).sh('npm test').text('done'));
  assert.ok(silent(gate(s)));
  const v = gate(s, ['--verbose']);
  assert.equal(v.out, ''); assert.match(v.err, /PROVEN/);
});

test('gemini BLOCK: unchecked edit gives decision deny + prefixed reason; failed test names the kind', () => {
  const r = gate(setup(new GFx().prompt().edit(F).text('done')));
  assert.ok(denied(r));
  const reason = JSON.parse(r.out).reason;
  assert.match(reason, /^apex-context gate: Code was edited/); assert.match(reason, /npm test/);
  const f = gate(setup(new GFx().prompt().edit(F).sh('npm test', 'not ok 1', 1).text('done')));
  assert.ok(denied(f)); assert.match(JSON.parse(f.out).reason, /test check/);
  const e2 = gate(setup(new GFx().prompt().write(F).text('done')), ['--exit2']);
  assert.equal(e2.code, 2); assert.match(e2.err, /nothing ran/);
});

test('gemini WARN (default): systemMessage on stdout, exit 0, no state', () => {
  const s = setup(new GFx().prompt().edit(F).text('done'));
  const r = gate(s, [], { warn: true });
  assert.equal(r.code, 0); assert.match(JSON.parse(r.out).systemMessage, /^apex-context: Code was edited/);
  assert.equal(fs.existsSync(s.stateDir), false);
});

test('gemini loop guard: stop_hook_active, then --max-blocks; the logged block reason is not a new turn', () => {
  const s = setup(new GFx().prompt().edit(F).text('done'));
  const a = gate(s, [], { payload: { ...s.payload, stop_hook_active: true } });
  assert.equal(a.out, ''); assert.match(a.err, /unverified/);
  assert.ok(denied(gate(s))); assert.ok(denied(gate(s)));
  const third = gate(s); assert.equal(third.out, ''); assert.match(third.err, /unverified/);
  // Gemini records our reason as a user message and keeps going: still the same turn, and the check clears it
  const fx = new GFx().prompt().edit(F).text('done').prompt('apex-context gate: Code was edited and nothing ran').sh('npm test').text('done');
  assert.ok(silent(gate(setup(fx))));
  const unchecked = new GFx().prompt().edit(F).text('done').prompt('apex-context gate: Code was edited and nothing ran').text('still done');
  assert.ok(denied(gate(setup(unchecked))));
  // a genuine new prompt starts a new turn
  assert.ok(silent(gate(setup(new GFx().prompt().edit(F).text('done').prompt('thanks, now explain it').text('ok')))));
});

test('gemini scoping: tests/docs/config edits, no runner, shell edits', () => {
  for (const f of ['math.test.js', 'test/x.js', 'README.md', 'package.json']) assert.ok(silent(gate(setup(new GFx().prompt().edit(f).text('done')))), f);
  assert.ok(silent(gate(setup(new GFx().prompt().edit(F).text('done'), { runner: false }))));
  assert.ok(denied(gate(setup(new GFx().prompt().sh("sed -i 's/a/b/' src/a.py").text('done')))));
  assert.ok(silent(gate(setup(new GFx().prompt().sh("sed -i 's/a/b/' README.md").text('done')))));
  assert.ok(silent(gate(setup(new GFx().prompt().edit('/tmp/x/scratch.js').text('done')))));
});

test('scoping: a project that itself lives under a scratch path still counts (files inside cwd)', () => {
  const s = setup(new GFx().prompt().edit('PLACEHOLDER').text('done'));
  const f = path.join(s.dir, 'src', 'a.js'); // s.dir is under os.tmpdir()
  fs.writeFileSync(s.tp, new GFx().prompt().edit(f).text('done').toString());
  assert.ok(denied(gate(s)));
  // but the same tmp file with an unrelated cwd stays scratch
  assert.ok(silent(gate(s, [], { payload: { ...s.payload, cwd: '/home/nobody/proj' } })));
});

test('gemini fail open: bad JSON, no transcript, missing file, garbage file, bad flag', () => {
  const s = setup(new GFx().prompt().edit(F).text('done'));
  assert.ok(silent(gate(s, [], { stdin: 'not json' })));
  assert.ok(silent(gate(s, [], { payload: { ...s.payload, transcript_path: undefined } })));
  assert.ok(silent(gate(s, [], { payload: { ...s.payload, transcript_path: '/nonexistent/s.json' } })));
  fs.writeFileSync(s.tp, '{{{{ garbage');
  assert.ok(silent(gate(s)));
  const v = gate(s, ['--verbose']); assert.equal(v.code, 0); assert.equal(v.out, '');
  assert.ok(silent(gate(s, ['--agent', 'bogus'])));
});

test('loadCurrentTurn reads a whole-document session', () => {
  const s = setup(new GFx().prompt('one').edit(F).text('a').prompt('two').sh('npm test').text('b'));
  const r = loadCurrentTurn(s.tp, gemini);
  assert.equal(callsOf(r.turns).length, 1);
  assert.equal(evaluateCalls(callsOf(r.turns), s.dir).edited, false);
});

test('install-hook --agent gemini: dry run default; --write merges into AfterAgent, idempotent; uninstall reverses', () => {
  const dir = tmp(); const file = path.join(dir, '.gemini', 'settings.json');
  const o = [], e = [];
  const go = (args) => { o.length = 0; return run(args, { out: (x) => o.push(x), err: (x) => e.push(x), cwd: dir, env: { GEMINI_CLI_HOME: path.join(dir, 'uh') } }); };
  assert.equal(go(['install-hook', '--agent', 'gemini']), 0);
  assert.match(o.join('\n'), /Dry run/); assert.equal(fs.existsSync(file), false);
  assert.match(o.join('\n'), /"AfterAgent"/); assert.match(o.join('\n'), /gate --agent gemini/);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ theme: 'x', hooks: { AfterAgent: [{ hooks: [{ type: 'command', command: 'other' }] }], BeforeTool: [{ matcher: '*', hooks: [] }] } }));
  go(['install-hook', '--agent', 'gemini', '--write', '--block']);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(j.theme, 'x'); assert.equal(j.hooks.AfterAgent.length, 2); assert.equal(j.hooks.AfterAgent[0].hooks[0].command, 'other');
  assert.match(j.hooks.AfterAgent[1].hooks[0].command, /gate --agent gemini --block$/);
  assert.ok(!j.hooks.Stop);
  const before = fs.readFileSync(file, 'utf8');
  go(['install-hook', '--agent', 'gemini', '--write']); assert.match(o.join('\n'), /Already installed/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  go(['install-hook', '--agent', 'gemini', '--dry-run', '--write']); assert.equal(fs.readFileSync(file, 'utf8'), before);
  go(['uninstall-hook', '--agent', 'gemini', '--write']);
  const k = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(k.hooks.AfterAgent.length, 1); assert.ok(k.hooks.BeforeTool);
  // user target honours GEMINI_CLI_HOME; Claude install is untouched by the gemini one
  go(['install-hook', '--agent', 'gemini', '--user', '--write']);
  assert.ok(fs.existsSync(path.join(dir, 'uh', '.gemini', 'settings.json')));
  fs.writeFileSync(file, '{ nope'); assert.equal(go(['install-hook', '--agent', 'gemini', '--write']), 1);
});

test('report --agent gemini reads chats/session-*.json only', () => {
  const dir = tmp();
  const chats = path.join(dir, 'proj', 'chats'); fs.mkdirSync(chats, { recursive: true });
  const now = Date.now();
  const fx = new GFx(); fx.t = now - 60000;
  fx.prompt().edit(F).text('All done.');
  fs.writeFileSync(path.join(chats, 'session-a.json'), fx.toString());
  fs.writeFileSync(path.join(dir, 'proj', 'logs.json'), '[{"x":1}]');
  const o = [];
  const code = run(['report', '--agent', 'gemini', '--dir', dir, '--json', '--since', '1d'], { out: (x) => o.push(x), err: () => {}, now });
  assert.equal(code, 0);
  const j = JSON.parse(o.join('\n'));
  assert.equal(j.completionClaims.claims, 1); assert.equal(j.completionClaims.unchecked, 1);
});
