// Claude Code transcript adapter. ALL knowledge of the on-disk format lives here.
// Other agents (Codex, Cursor, ...) can add a sibling module exporting the same
// two functions: `defaultDirs()` and `parseSession(text, meta)`.
//
// Normalized model (see typedefs below) is the only thing metrics.mjs sees.
// Message text is kept in memory only as a short tail for pattern matching;
// nothing in this package ever prints or stores it.

import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {{ input:number, cacheRead:number, cacheCreate:number, output:number }} Usage
 * @typedef {{ isError:boolean, exitCode:number|null, chars:number, lines:number, tail:string|null }} ToolResult
 * @typedef {{
 *   id:string, name:string,
 *   kind:'read'|'edit'|'write'|'bash'|'search'|'other',
 *   file:string|null,
 *   whole?:boolean,
 *   oldLines?:number, newLines?:number,
 *   command?:string, refs?:string,
 *   result:ToolResult|null
 * }} ToolCall
 * @typedef {{
 *   role:'user'|'assistant', ts:number|null, sidechain:boolean,
 *   isPrompt:boolean, model:string|null, msgId:string|null,
 *   usage:Usage|null, textTail:string|null, toolCalls:ToolCall[]
 * }} Turn
 * @typedef {{
 *   id:string, file:string, isSubagentFile:boolean,
 *   turns:Turn[], firstTs:number|null, lastTs:number|null,
 *   stats:{ lines:number, understood:number, malformed:number, skipped:number }
 * }} Session
 */

export const name = 'claude-code';
export const tailable = true;
export const matchFile = (fileName) => fileName.endsWith('.jsonl');
/** Claude Code's Stop payload: hook_event_name 'Stop' and a .jsonl transcript. */
export const detectPayload = (p) => !!p && typeof p === 'object' && (p.hook_event_name === 'Stop' || /\.jsonl$/.test(String(p.transcript_path || '')));

export function defaultDirs() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return [path.join(base, 'projects')];
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TEXT_TAIL = 1500;
const countLines = (s) => (s ? s.split('\n').length : 0);

function toolKind(n) {
  if (n === 'Read') return 'read';
  if (n === 'Edit' || n === 'MultiEdit' || n === 'NotebookEdit') return 'edit';
  if (n === 'Write') return 'write';
  if (n === 'Bash') return 'bash';
  if (n === 'Grep' || n === 'Glob') return 'search';
  return 'other';
}

function normalizeCall(block) {
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  const kind = toolKind(block.name);
  const file = typeof input.file_path === 'string' ? input.file_path
    : typeof input.notebook_path === 'string' ? input.notebook_path : null;
  /** @type {ToolCall} */
  const call = { id: String(block.id), name: String(block.name), kind, file, result: null };
  if (kind === 'read') call.whole = input.offset == null && input.limit == null;
  if (kind === 'edit') {
    if (block.name === 'MultiEdit' && Array.isArray(input.edits)) {
      call.oldLines = input.edits.reduce((n, e) => n + Math.max(1, countLines(String(e?.old_string ?? ''))), 0);
      call.newLines = input.edits.reduce((n, e) => n + countLines(String(e?.new_string ?? '')), 0);
    } else {
      call.oldLines = Math.max(1, countLines(String(input.old_string ?? input.new_source ?? '')));
      call.newLines = countLines(String(input.new_string ?? input.new_source ?? ''));
    }
  }
  if (kind === 'bash') call.command = typeof input.command === 'string' ? input.command : '';
  if (kind === 'search' || kind === 'bash' || kind === 'edit' || kind === 'write') {
    // only used to test "was this file referenced again"; never output
    call.refs = kind === 'bash' ? call.command : JSON.stringify(input).slice(0, 4000);
  }
  return call;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
  return '';
}

/**
 * Parse one transcript file's text into a normalized Session. Tolerant: unknown
 * line types are skipped, malformed JSON is counted, never fatal.
 * @param {string} text
 * @param {{file?:string, isSubagentFile?:boolean}} [meta]
 * @returns {Session}
 */
export function parseSession(text, meta = {}) {
  const stats = { lines: 0, understood: 0, malformed: 0, skipped: 0 };
  /** @type {Turn[]} */
  const turns = [];
  const byMsgId = new Map();
  const callById = new Map();
  let id = null, firstTs = null, lastTs = null, cwd = null;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    stats.lines++;
    let o;
    try { o = JSON.parse(line); } catch { stats.malformed++; continue; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) { stats.malformed++; continue; }
    if (typeof o.sessionId === 'string' && !id) id = o.sessionId;
    if (typeof o.cwd === 'string' && !cwd) cwd = o.cwd;
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    const tsv = Number.isFinite(ts) ? ts : null;
    const msg = o.message;
    const content = msg && msg.content;

    if (o.type === 'assistant' && msg && typeof msg === 'object') {
      stats.understood++;
      if (tsv != null) { firstTs = firstTs == null ? tsv : Math.min(firstTs, tsv); lastTs = lastTs == null ? tsv : Math.max(lastTs, tsv); }
      const u = msg.usage || {};
      const usage = {
        input: +u.input_tokens || 0,
        cacheRead: +u.cache_read_input_tokens || 0,
        cacheCreate: +u.cache_creation_input_tokens || 0,
        output: +u.output_tokens || 0,
      };
      const mid = typeof msg.id === 'string' ? msg.id : null;
      let turn = mid ? byMsgId.get(mid) : null;
      if (turn) {
        // one API message is logged once per content block with repeated usage: take max
        for (const k of Object.keys(usage)) turn.usage[k] = Math.max(turn.usage[k], usage[k]);
      } else {
        turn = {
          role: 'assistant', ts: tsv, sidechain: !!o.isSidechain, isPrompt: false,
          model: typeof msg.model === 'string' ? msg.model : null, msgId: mid,
          usage, textTail: null, toolCalls: [],
        };
        turns.push(turn);
        if (mid) byMsgId.set(mid, turn);
      }
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) turn.textTail = b.text.slice(-TEXT_TAIL);
          else if (b.type === 'tool_use' && b.id && b.name) {
            const call = normalizeCall(b);
            turn.toolCalls.push(call);
            callById.set(call.id, call);
          }
        }
      }
    } else if (o.type === 'user' && msg && typeof msg === 'object') {
      stats.understood++;
      if (tsv != null) { firstTs = firstTs == null ? tsv : Math.min(firstTs, tsv); lastTs = lastTs == null ? tsv : Math.max(lastTs, tsv); }
      let isPrompt = false, textHead = null;
      if (typeof content === 'string') { isPrompt = !o.isMeta; if (isPrompt) textHead = content.slice(0, 40); }
      else if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === 'tool_result') {
            const call = callById.get(b.tool_use_id);
            if (call) {
              const t = resultText(b.content);
              const f = o.toolUseResult && typeof o.toolUseResult === 'object' ? o.toolUseResult.file : null;
              call.result = {
                isError: b.is_error === true,
                // Claude Code marks non-zero exits with is_error and a leading "Exit code N"
                exitCode: call.kind !== 'bash' ? null
                  : (b.is_error === true ? (/^Exit code (\d+)/.exec(t)?.[1] != null ? +/^Exit code (\d+)/.exec(t)[1] : null) : 0),
                chars: t.length,
                lines: f && Number.isFinite(f.totalLines) ? f.totalLines : countLines(t),
                tail: call.kind === 'bash' ? t.slice(-TEXT_TAIL) : null,
              };
            }
          } else if (b && b.type === 'text' && !o.isMeta) { isPrompt = true; if (textHead == null && typeof b.text === 'string') textHead = b.text.slice(0, 40); }
        }
      }
      turns.push({
        role: 'user', ts: tsv, sidechain: !!o.isSidechain, isPrompt, model: null, msgId: null,
        usage: null, textTail: null, toolCalls: [], textHead,
      });
    } else {
      stats.skipped++;
    }
  }
  return {
    id: id || meta.file || 'unknown', file: meta.file || '', isSubagentFile: !!meta.isSubagentFile,
    turns, firstTs, lastTs, stats, cwd,
  };
}

export { EDIT_TOOLS };
