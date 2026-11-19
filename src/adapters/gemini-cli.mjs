// Gemini CLI adapter. ALL knowledge of Gemini's on-disk session format lives here.
// Same contract as claude-code.mjs: `defaultDirs()`, `parseSession(text, meta)`, plus
// `matchFile(name, fullPath)` (which files are sessions) and `tailable` (false: the
// session is ONE pretty-printed JSON document that Gemini rewrites on every change,
// not an append-only JSONL, so it must be read whole).
//
// Format (observed on Gemini CLI 0.32.1; see README "Gemini CLI" for sources):
//   { sessionId, projectHash, startTime, lastUpdated, kind: 'main'|'subagent',
//     messages: [ { id, timestamp, type: 'user'|'gemini'|'info'|..., content,
//                   model?, tokens?: {input, output, cached, thoughts, tool, total},
//                   toolCalls?: [ { id, name, args, status, timestamp,
//                                   result: [ { functionResponse: { response: { output } } } ] } ] } ] }
// A user message's content is an array of {text} parts (older files: a string).
// There is no cwd inside the session file; the hook payload carries it.

import os from 'node:os';
import path from 'node:path';

export const name = 'gemini-cli';
export const tailable = false;

export function defaultDirs() {
  const base = process.env.GEMINI_CLI_HOME ? path.join(process.env.GEMINI_CLI_HOME, '.gemini') : path.join(os.homedir(), '.gemini');
  return [path.join(base, 'tmp')];
}

/** Session files are <tmp>/<project>/chats/session-*.json (not logs.json, checkpoints, ...). */
export const matchFile = (fileName, fullPath) =>
  /^session-.*\.json$/.test(fileName) && path.basename(path.dirname(fullPath)) === 'chats';

/** Does this hook payload look like Gemini's? (AfterAgent event, or its prompt_response field.) */
export const detectPayload = (p) =>
  !!p && typeof p === 'object' && (p.hook_event_name === 'AfterAgent' || 'prompt_response' in p || /\.gemini[\\/]/.test(String(p.transcript_path || '')));

const TEXT_TAIL = 1500;
const countLines = (s) => (s ? s.split('\n').length : 0);

const KIND = {
  read_file: 'read', replace: 'edit', write_file: 'write', run_shell_command: 'bash',
  grep_search: 'search', search_file_content: 'search', glob: 'search', list_directory: 'search',
};

function responseText(result) {
  if (!Array.isArray(result)) return typeof result === 'string' ? result : '';
  return result.map((r) => {
    const resp = r && r.functionResponse && r.functionResponse.response;
    if (!resp) return '';
    if (typeof resp.output === 'string') return resp.output;
    if (typeof resp.error === 'string') return resp.error;
    return '';
  }).join('\n');
}

// A call that never executed is not evidence of anything: the user declined it ('cancelled'), or Gemini
// refused it because the tool is not offered in this mode (headless auto_edit has no shell tool).
const neverRan = (tc) => tc.status === 'cancelled' || (tc.status === 'error' && /^\s*Tool "[^"]*" not found/.test(responseText(tc.result)));

function normalizeCall(tc) {
  const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
  const kind = KIND[tc.name] || 'other';
  const file = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : null;
  const call = { id: String(tc.id), name: String(tc.name), kind, file, result: null };
  if (kind === 'read') call.whole = args.start_line == null && args.end_line == null;
  if (kind === 'edit') {
    call.oldLines = Math.max(1, countLines(String(args.old_string ?? '')));
    call.newLines = countLines(String(args.new_string ?? ''));
  }
  if (kind === 'bash') call.command = typeof args.command === 'string' ? args.command : '';
  if (kind === 'search' || kind === 'bash' || kind === 'edit' || kind === 'write') {
    call.refs = kind === 'bash' ? call.command : JSON.stringify(args).slice(0, 4000);
  }
  const status = typeof tc.status === 'string' ? tc.status : null;
  if (status && status !== 'executing' && status !== 'scheduled' && status !== 'validating') {
    const t = responseText(tc.result);
    let exitCode = null;
    if (kind === 'bash') {
      // The shell tool appends a line "Exit Code: N" only when N != 0 (a spawn error may add "Error: ...").
      const all = [...t.matchAll(/^Exit Code: (-?\d+)\s*$/gm)];
      exitCode = all.length ? +all[all.length - 1][1] : (status === 'success' ? 0 : null);
    }
    const isError = status === 'error' || status === 'cancelled';
    call.result = {
      isError, exitCode, chars: t.length, lines: countLines(t),
      tail: kind === 'bash' ? t.slice(-TEXT_TAIL) : null,
    };
  }
  return call;
}

const partsText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('') : '');
const isoMs = (s) => { const t = typeof s === 'string' ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };

/**
 * Parse one session file's text. Tolerant: non-JSON text counts as one malformed line.
 * @returns the same normalized Session shape as the Claude Code adapter
 */
export function parseSession(text, meta = {}) {
  const stats = { lines: 0, understood: 0, malformed: 0, skipped: 0 };
  const turns = [];
  let doc;
  try { doc = JSON.parse(text); } catch { doc = null; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.messages)) {
    stats.lines = 1; stats.malformed = 1;
    return { id: meta.file || 'unknown', file: meta.file || '', isSubagentFile: false, turns, firstTs: null, lastTs: null, stats, cwd: null };
  }
  let firstTs = null, lastTs = null;
  for (const m of doc.messages) {
    stats.lines++;
    if (!m || typeof m !== 'object') { stats.malformed++; continue; }
    const ts = isoMs(m.timestamp);
    if (m.type !== 'user' && m.type !== 'gemini') { stats.skipped++; continue; }
    stats.understood++;
    if (ts != null) { firstTs = firstTs == null ? ts : Math.min(firstTs, ts); lastTs = lastTs == null ? ts : Math.max(lastTs, ts); }
    if (m.type === 'user') {
      const text0 = partsText(m.content);
      turns.push({ role: 'user', ts, sidechain: false, isPrompt: true, model: null, msgId: m.id || null, usage: null, textTail: null, toolCalls: [], textHead: text0.slice(0, 40) });
      continue;
    }
    const tk = m.tokens && typeof m.tokens === 'object' ? m.tokens : {};
    const cached = +tk.cached || 0;
    // Gemini's tokens.input includes the cached share (total = input + output + thoughts + tool).
    const usage = { input: Math.max(0, (+tk.input || 0) - cached), cacheRead: cached, cacheCreate: 0, output: (+tk.output || 0) + (+tk.thoughts || 0) };
    const content = partsText(m.content);
    turns.push({
      role: 'assistant', ts, sidechain: false, isPrompt: false, model: typeof m.model === 'string' ? m.model : null,
      msgId: m.id || null, usage, textTail: content.trim() ? content.slice(-TEXT_TAIL) : null,
      toolCalls: Array.isArray(m.toolCalls) ? m.toolCalls.filter((t) => t && t.id && t.name && !neverRan(t)).map(normalizeCall) : [],
    });
  }
  return {
    id: typeof doc.sessionId === 'string' ? doc.sessionId : (meta.file || 'unknown'), file: meta.file || '',
    isSubagentFile: doc.kind != null && doc.kind !== 'main', turns, firstTs, lastTs, stats, cwd: null,
  };
}
