import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as claude from './adapters/claude-code.mjs';
import * as gemini from './adapters/gemini-cli.mjs';
import { loadSessions, parseSince } from './load.mjs';
import { computeAll, EXPLAIN } from './metrics.mjs';
import { runGate, GATE_EXPLAIN } from './gate.mjs';
import { runHookCommand } from './hooks.mjs';
import { HELP as BENCH_HELP } from './bench/help.mjs';
import { renderReport, renderJson, renderShare, noLogsMessage } from './render.mjs';

const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;

const HELP = `apex-context ${VERSION}: local, read-only checks on your coding-agent logs. No network, no accounts.

Usage: apex-context <command> [options]

Commands
  report          Show token spend, avoidable input and unchecked "done" claims from your local logs (start here)
  gate            Stop/AfterAgent hook: warn (or block) when code was edited and nothing proved it
  install-hook    Print (dry run) or write the hook entry in a settings.json
  uninstall-hook  Print (dry run) or remove that hook entry
  bench           Compare agent setups on the same tasks (run, validate, report); makes no network calls itself

Options
  -h, --help      Show help (also: apex-context <command> --help)
  --version       Show the version

Try first:  npx apex-context report
`;

export { VERSION };

const COMMAND_HELP = {
  bench: BENCH_HELP,
  report: `apex-context report [options]

Reads your local session logs read-only and prints aggregates only (counts, shares, dollar estimates, model names).
  --agent claude|gemini   which agent's logs (default claude: ~/.claude/projects; gemini: ~/.gemini/tmp)
  --since <window>        e.g. 12h, 30d, 2w (default 30d)
  --dir <path>            read this folder instead of the default
  --prices <file>         JSON price table overriding the built-in one
  --json                  aggregates as JSON
  --share                 short text card
  --explain               print the formulas and exit
`,
  gate: `apex-context gate [options]   (reads the hook JSON on stdin)

Claude Code Stop hook / Gemini CLI AfterAgent hook. Warns by default; fails open on any error.
  --agent claude|gemini   default: auto-detect from the payload
  --block                 block the stop instead of warning (or APEX_CONTEXT_GATE_MODE=block)
  --strict                treat "manually checked" as unchecked
  --allow-manual          with --strict, allow manual checks again
  --max-blocks <N>        blocks per turn before allowing (default 2)
  --exit2                 block via exit code 2 and stderr instead of JSON
  --verbose               one-line reason on stderr for every allow
  --explain               print the decision rules and exit
Turn it off: APEX_CONTEXT_GATE=off
`,
  'install-hook': `apex-context install-hook [options]

Dry run by default: prints the entry it would add and the target file. Nothing is written without --write.
  --agent claude|gemini   default claude
  --block                 install the blocking form of the hook
  --project | --user      ./.claude (or ./.gemini) settings, or the user-level file (default --project)
  --settings <file>       use this settings file
  --write                 apply the change
  --dry-run               force a dry run
`,
  'uninstall-hook': `apex-context uninstall-hook [options]

Dry run by default. Removes only the apex-context gate entry.
  --agent claude|gemini   default claude
  --project | --user      as for install-hook
  --settings <file>       use this settings file
  --write                 apply the change
`,
};

export function parseArgs(argv) {
  const a = { cmd: null, since: '30d', dir: null, prices: null, json: false, share: false, explain: false, help: false, strict: false, block: false, allowManual: false, maxBlocks: 2, exit2: false, verbose: false, user: false, write: false, dryRun: false, settings: null, agent: null, version: false, rest: null, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const val = (k) => { const v = argv[i + 1]; if (v == null || v.startsWith('--')) { a.errors.push(`Missing value for ${k}`); return null; } i++; return v; };
    if (t === '--since') a.since = val(t);
    else if (t === '--dir') a.dir = val(t);
    else if (t === '--prices') a.prices = val(t);
    else if (t === '--json') a.json = true;
    else if (t === '--share') a.share = true;
    else if (t === '--explain') a.explain = true;
    else if (t === '--block') a.block = true;
    else if (t === '--strict') a.strict = true;
    else if (t === '--allow-manual') a.allowManual = true;
    else if (t === '--max-blocks') { const n = Number(argv[++i]); if (Number.isInteger(n) && n >= 0) a.maxBlocks = n; else a.errors.push('Invalid --max-blocks'); }
    else if (t === '--exit2') a.exit2 = true;
    else if (t === '--verbose') a.verbose = true;
    else if (t === '--user') a.user = true;
    else if (t === '--project') a.user = false;
    else if (t === '--write') a.write = true;
    else if (t === '--dry-run') a.dryRun = true;
    else if (t === '--settings') a.settings = val(t);
    else if (t === '--agent') { const v = String(argv[++i] || '').toLowerCase(); if (['claude', 'claude-code', 'gemini', 'gemini-cli', 'auto'].includes(v)) a.agent = v; else a.errors.push('Invalid --agent (claude, gemini)'); }
    else if (t === '-h' || t === '--help') a.help = true;
    else if (t === '--version' || t === '-v') a.version = true;
    else if (!t.startsWith('-') && !a.cmd) a.cmd = t;
    else if (!t.startsWith('-') && a.cmd === 'help' && !a.rest) a.rest = t;
    else a.errors.push(`Unknown option: ${t}`);
  }
  return a;
}

export function run(argv, { out = (s) => process.stdout.write(s + '\n'), err = (s) => process.stderr.write(s + '\n'), isTTY = process.stdout.isTTY, now = Date.now(), stdin = null, env = process.env, cwd = process.cwd(), stateDir } = {}) {
  const a = parseArgs(argv);
  if (a.version) { out(VERSION); return 0; }
  if (a.cmd === 'help') { const t = a.rest; out(COMMAND_HELP[t] || HELP); return 0; }
  if (a.help) { out(COMMAND_HELP[a.cmd] || HELP); return 0; }
  if (!a.cmd) { if (a.errors.length) { err(a.errors.join('\n') + '\nRun apex-context --help.'); return 2; } out(HELP); return 0; }
  if (a.cmd === 'gate' && a.errors.length) { if (a.verbose) err('apex-context gate: failing open (' + a.errors.join('; ') + ')'); return 0; }
  if (a.errors.length) { err(a.errors.join('\n')); return 2; }
  if (a.cmd === 'gate') {
    if (a.explain) { out(GATE_EXPLAIN); return 0; }
    let input = '';
    try { input = stdin != null ? stdin : (String(env.APEX_CONTEXT_GATE || '').toLowerCase() === 'off' ? '' : fs.readFileSync(0, 'utf8')); } catch { /* fail open below */ }
    return runGate({ strict: a.strict, block: a.block, agent: a.agent, allowManual: a.allowManual, maxBlocks: a.maxBlocks, exit2: a.exit2, verbose: a.verbose, stateDir }, { stdin: input, env, out, err });
  }
  if (a.cmd === 'install-hook' || a.cmd === 'uninstall-hook') {
    return runHookCommand({ action: a.cmd === 'install-hook' ? 'install' : 'uninstall', agent: a.agent, block: a.block, user: a.user, write: a.write, dryRun: a.dryRun, settings: a.settings }, { cwd, env, out, err });
  }
  if (a.cmd !== 'report') { err(`Unknown command: ${a.cmd}\nRun apex-context --help for the command list.`); return 2; }
  if (a.explain) { out(EXPLAIN); return 0; }
  const sinceMs = parseSince(a.since);
  if (sinceMs == null) { err('Invalid --since (use e.g. 12h, 30d, 2w)'); return 2; }
  let prices;
  try {
    const p = a.prices || path.join(path.dirname(fileURLToPath(import.meta.url)), 'prices.json');
    prices = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { err('Could not read the price table.'); return 2; }
  const adapter = /^gemini/.test(a.agent || '') ? gemini : claude;
  const dirs = a.dir ? [path.resolve(a.dir)] : adapter.defaultDirs();
  const { sessions, info } = loadSessions({ dirs, sinceMs, now, adapter });
  if (!sessions.length) { out(noLogsMessage(adapter.name, !!a.dir, a.since)); return 0; }
  const m = computeAll(sessions, prices);
  const ctx = {
    window: a.since,
    parsing: {
      filesRead: info.filesInWindow, lines: info.lines, malformedLines: info.malformed, skippedLines: info.skipped,
      parsedPct: info.lines ? Math.round(((info.lines - info.malformed) / info.lines) * 1000) / 10 : 100,
      messagePct: info.lines ? Math.round((info.understood / info.lines) * 1000) / 10 : 100,
    },
  };
  if (a.json) out(renderJson(m, ctx));
  else if (a.share) out(renderShare(m, ctx));
  else out(renderReport(m, ctx, { color: !!isTTY && !process.env.NO_COLOR }));
  return 0;
}
