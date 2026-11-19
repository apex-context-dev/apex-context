// `apex-context gate`: a Claude Code Stop hook. Blocks the agent from ending its
// turn when code was edited in the current turn and nothing verified it.
// Fails OPEN on any error. Reads the transcript tail-first. No network.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as claude from './adapters/claude-code.mjs';
import * as gemini from './adapters/gemini-cli.mjs';
import { isEditCall, checkKind, looksFailed } from './metrics.mjs';

/** Error class only: messages can contain paths. */
export const errClass = (e) => (e && e.constructor && /^[A-Za-z]{1,30}$/.test(e.constructor.name) ? e.constructor.name : 'Error');
export const DEFAULT_MAX_BLOCKS = 2;
const TAIL_START = 512 * 1024;
// Our own continuation messages are not new user prompts: Claude Code logs the block
// reason as "Stop hook feedback...", Gemini CLI logs it as a user message with the reason text.
const STOP_FEEDBACK_RE = /^\s*(?:Stop hook feedback|apex-context gate:)/i;

export const ADAPTERS = { claude, gemini };
export const AGENT_NAMES = Object.keys(ADAPTERS);
/** 'claude' | 'gemini' from an explicit --agent, else from the payload's shape. */
export function resolveAgent(requested, payload) {
  const r = String(requested || 'auto').toLowerCase();
  if (r === 'claude' || r === 'claude-code') return 'claude';
  if (r === 'gemini' || r === 'gemini-cli') return 'gemini';
  if (r !== 'auto') throw new Error('unknown --agent ' + r);
  if (gemini.detectPayload(payload) && !(payload && payload.hook_event_name === 'Stop')) return 'gemini';
  return 'claude';
}

// ---------- reading the transcript, tail first ----------

/** Read the last `bytes` of a file as complete lines (drops a cut first line). */
function readTail(fd, size, bytes) {
  const start = Math.max(0, size - bytes);
  const len = size - start;
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, start + got);
    if (n <= 0) break;
    got += n;
  }
  let text = buf.toString('utf8', 0, got);
  if (start > 0) { const nl = text.indexOf('\n'); text = nl < 0 ? '' : text.slice(nl + 1); }
  return { text, whole: start === 0 };
}

export const isRealPrompt = (t) => t.role === 'user' && t.isPrompt && !t.sidechain && !STOP_FEEDBACK_RE.test(t.textHead || '');

/**
 * Parse only as much of the file's end as needed to include the last real user
 * prompt. Returns { session, turns (current turn, main chain), promptTs, bytesRead }.
 */
export function loadCurrentTurn(file, adapter = claude) {
  if (adapter.tailable === false) {
    // whole-document sessions (Gemini): no tail trick possible, read it all
    const session = adapter.parseSession(fs.readFileSync(file, 'utf8'), { file });
    const main = session.turns.filter((t) => !t.sidechain);
    let at = -1;
    for (let i = main.length - 1; i >= 0; i--) if (isRealPrompt(main[i])) { at = i; break; }
    return { session, turns: main.slice(at + 1), promptTs: at >= 0 ? main[at].ts : null, bytesRead: fs.statSync(file).size };
  }
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let bytes = TAIL_START;
    for (;;) {
      const { text, whole } = readTail(fd, size, bytes);
      const session = adapter.parseSession(text, { file });
      const main = session.turns.filter((t) => !t.sidechain);
      let at = -1;
      for (let i = main.length - 1; i >= 0; i--) if (isRealPrompt(main[i])) { at = i; break; }
      if (at >= 0 || whole) {
        return { session, turns: main.slice(at + 1), promptTs: at >= 0 ? main[at].ts : null, bytesRead: Math.min(bytes, size) };
      }
      bytes *= 4;
    }
  } finally { fs.closeSync(fd); }
}

// ---------- evaluating a turn ----------

/** Name the kind of check from its command (never from output text). */
export function checkKindName(cmd = '') {
  if (/\btest\b|\bpytest\b|\bjest\b|\bvitest\b|\bmocha\b|--test\b|\.test\.|\bunittest\b|\bplaywright\b|\bcypress\b/i.test(cmd)) return 'test';
  if (/\btsc\b|\bmypy\b|\bpyright\b|type-?check/i.test(cmd)) return 'typecheck';
  if (/\blint\b|\beslint\b|\bruff\b|\bclippy\b|\bgo\s+vet\b/i.test(cmd)) return 'lint';
  if (/\bbuild\b|\bxcodebuild\b|\bcargo\s+check\b|\bpackage\b|\bverify\b/i.test(cmd)) return 'build';
  return 'check';
}

// ---------- scope: which edits count ----------

const SOURCE_EXT = 'js ts tsx jsx mjs cjs mts cts py go rs java kt kts rb php c cc cpp cxx h hpp swift cs scala m mm dart lua ex exs vue svelte'.split(' ');
const EXT_RE = new RegExp(`\\.(?:${SOURCE_EXT.join('|')})$`, 'i');
const FILE_TOKEN_RE = new RegExp(`[\\w@./~+-]+\\.(?:${SOURCE_EXT.join('|')})\\b`, 'gi');
const TEST_PATH_RES = [/(^|\/)(?:tests?|__tests__|specs?)\//i, /\.(?:test|spec)\.[a-z]+$/i, /(^|\/)test_[^/]*\.py$/i, /_test\.(?:go|py|rs|rb)$/i, /Tests?\.(?:swift|java|kt|cs)$/];
const SCRATCH_RES = [/^(?:\/private)?\/tmp\//, /^\/var\/folders\//, /(^|\/)scratchpad(\/|$)/i];
export const isSourcePath = (f) => EXT_RE.test(f);
export const isTestPath = (f) => TEST_PATH_RES.some((re) => re.test(f));
const inside = (f, dir) => !!dir && path.isAbsolute(f) && (f === dir || f.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep));
export const isScratchPath = (f) => SCRATCH_RES.some((re) => re.test(f)) || f.startsWith(os.tmpdir() + path.sep);

/** Files an edit call touched (Bash edits: source-looking file names in the command). */
function editedFiles(c) {
  if (c.kind === 'bash') return (c.command || '').match(FILE_TOKEN_RE) || [];
  return c.file ? [c.file] : [];
}
/** An edit counts only if it touches source code that is neither a test file nor scratch. */
// A project that itself lives under /tmp or a scratchpad folder is still a project: files inside the
// session's cwd are never "scratch" (found by running the gate on a project created in a scratchpad).
export const scopedFiles = (c, cwd) => (isEditCall(c) ? editedFiles(c).filter((f) => isSourcePath(f) && !isTestPath(f) && (!isScratchPath(f) || inside(f, cwd))) : []);
export const isScopedEdit = (c, cwd) => scopedFiles(c, cwd).length > 0;

/**
 * @param {any[]} calls tool calls of one turn in order
 * @returns {{edited:boolean, scoped:boolean, cls:null|'proven'|'manual'|'failed'|'unchecked', failKind:string|null}}
 * edited: any edit at all. scoped: a source-code edit (not test/docs/config/scratch). cls only when scoped.
 */
export function evaluateCalls(calls, cwd) {
  const edited = calls.some(isEditCall);
  let lastEdit = -1;
  calls.forEach((c, i) => { if (isScopedEdit(c, cwd)) lastEdit = i; });
  if (lastEdit < 0) return { edited, scoped: false, cls: null, failKind: null, files: [] };
  const files = [...new Set(calls.flatMap((c) => scopedFiles(c, cwd)))];
  const after = calls.slice(lastEdit + 1);
  const tests = after.filter((c) => checkKind(c) === 'test');
  if (tests.length) {
    const last = tests[tests.length - 1];
    if (looksFailed(last.result, last.command)) return { edited, scoped: true, files, cls: 'failed', failKind: checkKindName(last.command) };
    return { edited, scoped: true, files, cls: 'proven', failKind: null };
  }
  if (after.some((c) => checkKind(c) === 'manual')) return { edited, scoped: true, files, cls: 'manual', failKind: null };
  return { edited, scoped: true, files, cls: 'unchecked', failKind: null };
}

/** Does the gate block this class? */
export const blocksClass = (cls, { strict = false, allowManual = false } = {}) =>
  cls === 'failed' || cls === 'unchecked' || (cls === 'manual' && strict && !allowManual);

/** Split one session's main-chain turns into prompt-delimited segments (used by the replay). */
export function splitSegments(turns) {
  const segs = [];
  let cur = null;
  for (const t of turns) {
    if (t.sidechain) continue;
    if (isRealPrompt(t)) { cur = []; segs.push(cur); } else { if (!cur) { cur = []; segs.push(cur); } cur.push(t); }
  }
  return segs;
}
export const callsOf = (seg) => seg.flatMap((t) => (t.role === 'assistant' ? t.toolCalls : []));

// ---------- guessing the project's check commands ----------

const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const readSafe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

export function detectRunners(cwd) {
  const out = [];
  if (!cwd) return out;
  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (exists(pkgPath)) {
      let scripts = {};
      try { scripts = JSON.parse(readSafe(pkgPath)).scripts || {}; } catch { /* ignore */ }
      const pm = exists(path.join(cwd, 'pnpm-lock.yaml')) ? 'pnpm' : exists(path.join(cwd, 'yarn.lock')) ? 'yarn'
        : (exists(path.join(cwd, 'bun.lockb')) || exists(path.join(cwd, 'bun.lock'))) ? 'bun' : 'npm';
      const run = (n) => (n === 'test' ? `${pm} test` : `${pm} run ${n}`);
      for (const n of ['test', 'typecheck', 'type-check', 'lint', 'build']) {
        if (typeof scripts[n] === 'string' && !/no test specified/.test(scripts[n])) out.push(run(n));
      }
    }
    const py = readSafe(path.join(cwd, 'pyproject.toml'));
    if (exists(path.join(cwd, 'tox.ini'))) out.push('tox');
    if (exists(path.join(cwd, 'pytest.ini')) || /pytest|tox/.test(py)) out.push('pytest');
    if (exists(path.join(cwd, 'Cargo.toml'))) out.push('cargo test');
    if (exists(path.join(cwd, 'go.mod'))) out.push('go test ./...');
    const mk = readSafe(path.join(cwd, 'Makefile'));
    for (const t of ['test', 'check', 'lint']) if (new RegExp(`^${t}\\s*:`, 'm').test(mk)) out.push(`make ${t}`);
  } catch { /* guesses only */ }
  return out.slice(0, 5);
}

/**
 * Runners for a turn: the cwd's, plus the nearest manifest above each edited file
 * (covers a transcript started in a parent folder of the project). Guesses only.
 */
export function detectRunnersFor(files, cwd, cache = new Map()) {
  const det = (d) => { if (!cache.has(d)) cache.set(d, detectRunners(d)); return cache.get(d); };
  const found = new Set(cwd ? det(cwd) : []);
  const stop = os.homedir();
  for (const f of (files || []).slice(0, 5)) {
    let d = path.dirname(path.resolve(cwd || '/', f));
    for (let i = 0; i < 8 && d && d !== stop && d !== path.dirname(d); i++, d = path.dirname(d)) {
      const r = det(d);
      if (r.length) { r.forEach((x) => found.add(x)); break; }
    }
  }
  return [...found].slice(0, 5);
}

// ---------- per-session state (loop guard) ----------

export const defaultStateDir = () => path.join(os.tmpdir(), 'apex-context-gate');
// File name = hash of the session id; contents = turn key (a timestamp) and a block counter. Nothing else.
const stateFile = (dir, sid) => path.join(dir, crypto.createHash('sha256').update(String(sid)).digest('hex').slice(0, 32) + '.json');
function readState(dir, sid) { try { return JSON.parse(fs.readFileSync(stateFile(dir, sid), 'utf8')) || {}; } catch { return {}; } }
function writeState(dir, sid, st) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = stateFile(dir, sid);
    fs.writeFileSync(f, JSON.stringify({ turnKey: String(st.turnKey).slice(0, 40), blocks: st.blocks | 0 }), { mode: 0o600 });
    fs.chmodSync(f, 0o600);
  } catch { /* best effort; stop_hook_active still guards */ }
}

// ---------- the hook ----------

export const unverifiedNote = 'apex-context gate: allowing stop; this turn edited code and it is still unverified.';

// Fixed vocabulary: runner names printed in a reason can never carry script contents.
const RUNNER_VOCAB = /^(?:(?:npm|pnpm|yarn|bun) (?:test|run (?:typecheck|type-check|lint|build))|tox|pytest|cargo test|go test \.\/\.\.\.|make (?:test|check|lint))$/;
export function unverifiedReason(runners) {
  const guess = runners.filter((r) => RUNNER_VOCAB.test(r)).join(', ') || 'none found';
  return `Code was edited and nothing ran after the last edit. Run the project's tests/checks (detected: ${guess}), then report the result honestly; say 'unverified' if you can't.`;
}
export const failedReason = (kind) =>
  `The last ${kind} check that ran after your final edit failed. Fix the cause and re-run it, or report honestly that the work is unverified.`;

/**
 * Pure-ish decision. Returns { action:'allow'|'block', reason?, note? (stderr), verboseNote? }.
 * Throws on unexpected errors; the caller fails open.
 */
export function decide(payload, opts = {}) {
  const { strict = false, allowManual = false, block = false, maxBlocks = DEFAULT_MAX_BLOCKS, stateDir = defaultStateDir() } = opts;
  if (!payload || typeof payload !== 'object') throw new Error('payload is not an object');
  const tp = payload.transcript_path;
  if (typeof tp !== 'string' || !tp) throw new Error('no transcript_path');
  const agent = resolveAgent(opts.agent, payload);
  const { session, turns, promptTs } = loadCurrentTurn(tp, ADAPTERS[agent]);
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : session.cwd;
  const ev = evaluateCalls(callsOf(turns), cwd);
  if (!ev.edited) return { action: 'allow', verboseNote: 'no edits this turn' };
  if (!ev.scoped) return { action: 'allow', verboseNote: 'edits were only docs, config, tests or scratch files' };
  const runners = detectRunnersFor(ev.files, cwd);
  if (!runners.length) return { action: 'allow', verboseNote: 'no test/typecheck/build runner detected for this project' };
  if (!blocksClass(ev.cls, { strict, allowManual })) {
    return { action: 'allow', verboseNote: `verified (${ev.cls === 'proven' ? 'PROVEN' : 'MANUALLY CHECKED'}): code edits were checked after the last edit` };
  }
  const reason = ev.cls === 'failed' ? failedReason(ev.failKind) : unverifiedReason(runners);
  if (!block) return { action: 'warn', message: 'apex-context: ' + reason, cls: ev.cls, agent };
  // Blocking mode. Loop guards first.
  if (payload.stop_hook_active === true) return { action: 'allow', note: unverifiedNote };
  const sid = typeof payload.session_id === 'string' && payload.session_id
    ? payload.session_id : 'tp-' + crypto.createHash('sha1').update(tp).digest('hex').slice(0, 16);
  const turnKey = String(promptTs ?? 'start');
  const st = readState(stateDir, sid);
  const blocks = st.turnKey === turnKey ? (+st.blocks || 0) : 0;
  if (blocks >= maxBlocks) return { action: 'allow', note: unverifiedNote };
  writeState(stateDir, sid, { turnKey, blocks: blocks + 1 });
  return { action: 'block', reason: agent === 'gemini' ? 'apex-context gate: ' + reason : reason, cls: ev.cls, agent };
}

/**
 * Entry used by the CLI. Returns the process exit code. Never throws.
 */
export function runGate(opts, { stdin = '', env = process.env, out = () => {}, err = () => {} } = {}) {
  const verbose = !!opts.verbose;
  try {
    if (String(env.APEX_CONTEXT_GATE || '').toLowerCase() === 'off') { if (verbose) err('apex-context gate: disabled by APEX_CONTEXT_GATE=off'); return 0; }
    if (String(env.APEX_CONTEXT_GATE_MODE || '').toLowerCase() === 'block') opts = { ...opts, block: true };
    let payload;
    try { payload = JSON.parse(stdin); } catch { throw new Error('hook input is not valid JSON'); }
    const r = decide(payload, opts);
    if (r.action === 'block') {
      if (opts.exit2) { err(r.reason); return 2; }
      // Claude Code: decision "block". Gemini CLI: "deny" (it accepts both, documents deny).
      out(JSON.stringify({ decision: r.agent === 'gemini' ? 'deny' : 'block', reason: r.reason }));
      return 0;
    }
    if (r.action === 'warn') { out(JSON.stringify({ systemMessage: r.message })); return 0; }
    if (r.note) err(r.note);
    else if (verbose && r.verboseNote) err('apex-context gate: ' + r.verboseNote);
    return 0;
  } catch (e) {
    if (verbose) err('apex-context gate: failing open (' + errClass(e) + ')');
    return 0;
  }
}

export const GATE_EXPLAIN = `apex-context gate: how it decides

It runs as a Claude Code Stop hook. Only the CURRENT turn is looked at (everything
since the last real user message; hook feedback messages are not counted as one).
  Scope (an edit only counts when ALL of this holds, otherwise allow silently):
     - at least one edited file is source code (js ts tsx jsx mjs cjs py go rs java kt rb php
       c cc cpp h swift cs scala ...), not docs, json/yaml/toml config, lock files, images
       or shell/dotfiles
     - it is not a test file (test/ tests/ __tests__/, *.test.*, *.spec.*, test_*.py, *_test.go)
       and not scratch (/tmp, /var/folders, a scratchpad folder)
     - the project (the transcript's cwd) has a detectable runner: package.json scripts
       test/typecheck/build/lint, pytest.ini/tox.ini/pytest in pyproject, Cargo.toml,
       go.mod, or a Makefile test/check/lint target
     Bash edits count by the source-looking file names in the command.
  Then look only at what ran AFTER the last in-scope edit:
       PROVEN           a test/typecheck/lint/build command ran and the last one exited 0
                        -> allow (one "verified" line on stderr with --verbose)
       MANUALLY CHECKED a script/node/python/curl/grep or browser/simulator tool ran
                        -> allow (with --strict: treated as UNCHECKED, unless --allow-manual)
       FAILED           the last test/typecheck/lint/build command failed (recorded
                        non-zero exit; for piped commands, also failure text)
                        -> warn, naming the kind of check
       UNCHECKED        nothing like the above ran
                        -> warn, with the project's likely test commands
  Default mode is WARN: the stop is allowed and a one-line message is printed as
  {"systemMessage": ...} on stdout (exit 0). --block (or APEX_CONTEXT_GATE_MODE=block)
  turns warnings into blocks: {"decision":"block","reason":...}; --exit2 uses exit 2 + stderr.
  Blocking never loops: stop_hook_active=true, or --max-blocks (default ${DEFAULT_MAX_BLOCKS}) blocks
  already this turn (state file per session under the OS temp dir) means allow with an
  "unverified" note on stderr.
  Fails open: bad JSON, missing/unreadable transcript, any error -> exit 0, no output
  (a reason on stderr only with --verbose).
Disable with APEX_CONTEXT_GATE=off. It keys on edits, not on what the agent says.
`;
