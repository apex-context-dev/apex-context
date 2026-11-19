#!/usr/bin/env node
// Read-only replay of the gate (new defaults: scoped, warn mode) over local Claude Code
// history. Prints aggregates only: no text, paths, session ids or project names.
// Usage: node scripts/replay-gate.mjs [--dir <path>] [--since 3650d]
// Caveat: the runner check looks at each session's recorded cwd as it exists NOW; a
// project that has moved or been deleted counts as "no runner" (so scope errs small).
import * as claude from '../src/adapters/claude-code.mjs';
import { loadSessions, parseSince } from '../src/load.mjs';
import { evaluateCalls, blocksClass, splitSegments, callsOf, detectRunnersFor } from '../src/gate.mjs';
import { checkKind, looksFailed } from '../src/metrics.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const dirs = arg('--dir') ? [arg('--dir')] : claude.defaultDirs();
const { sessions, info } = loadSessions({ dirs, sinceMs: parseSince(arg('--since', '3650d')), adapter: claude });

const N = 2; // "next user turns" window
const runnerCache = new Map();
const hasRunner = (files, cwd) => detectRunnersFor(files, cwd, runnerCache).length > 0;
const r = {
  sessions: 0, segments: 0, editTurns: 0, editTurnsEndedWithFinalMessage: 0,
  outOfScope: { docsConfigTestScratchOnly: 0, noRunnerDetected: 0 }, inScope: 0,
  inScopeClass: { proven: 0, manual: 0, failed: 0, unchecked: 0 },
  warnings: 0, warningsStrict: 0, blocksUnderBlockMode: 0,
  warnedFollowedByTest: 0, warnedLaterTestFailed: 0, notWarnedInScope: 0, notWarnedFollowedByTest: 0,
};
for (const s of sessions) {
  if (s.isSubagentFile) continue;
  r.sessions++;
  const segs = splitSegments(s.turns);
  const calls = segs.map(callsOf);
  segs.forEach((g, i) => {
    r.segments++;
    const ev = evaluateCalls(calls[i]);
    if (!ev.edited) return;
    const last = [...g].reverse().find((t) => t.role === 'assistant');
    if (!last || last.toolCalls.length) return; // turn did not end on a final message
    r.editTurns++; r.editTurnsEndedWithFinalMessage++;
    if (!ev.scoped) { r.outOfScope.docsConfigTestScratchOnly++; return; }
    if (!hasRunner(ev.files, s.cwd)) { r.outOfScope.noRunnerDetected++; return; }
    r.inScope++; r.inScopeClass[ev.cls]++;
    const next = calls.slice(i + 1, i + 1 + N).flat();
    const tests = next.filter((c) => checkKind(c) === 'test');
    if (blocksClass(ev.cls)) {
      r.warnings++; r.blocksUnderBlockMode++;
      if (tests.length) r.warnedFollowedByTest++;
      if (tests.some((c) => looksFailed(c.result, c.command))) r.warnedLaterTestFailed++;
    } else { r.notWarnedInScope++; if (tests.length) r.notWarnedFollowedByTest++; }
    if (blocksClass(ev.cls, { strict: true })) r.warningsStrict++;
  });
}
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + '%' : 'n/a');
console.log(JSON.stringify({
  ...r, filesRead: info.filesInWindow,
  inScopeShareOfEditTurns: pct(r.inScope, r.editTurns),
  warningShareOfEditTurns: pct(r.warnings, r.editTurns),
  warningShareOfEditTurnsStrict: pct(r.warningsStrict, r.editTurns),
  blockShareOfEditTurns: pct(r.blocksUnderBlockMode, r.editTurns),
  warnedFollowedByTestShare: pct(r.warnedFollowedByTest, r.warnings),
  notWarnedFollowedByTestShare: pct(r.notWarnedFollowedByTest, r.notWarnedInScope),
  warnedLaterTestFailedShare: pct(r.warnedLaterTestFailed, r.warnings),
  note: `"followed by test" = a test/typecheck/lint/build command in the next ${N} user turns of the same session; "later test failed" = such a command with a failing exit status. Whether the next user message reports a problem cannot be judged from structure alone, so that sub-metric is skipped.`,
}, null, 2));
