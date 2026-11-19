// Output only aggregates: counts, shares, dollar estimates, model names.
// Never paths, project names, prompts or message text.

export function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(Math.round(n));
}
export const fmtUsd = (n) => '$' + (n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2));
export const pct = (x) => (x == null ? 'n/a' : (x * 100 < 10 ? (x * 100).toFixed(1) : Math.round(x * 100)) + '%');

export function renderJson(m, ctx) {
  return JSON.stringify({
    window: ctx.window,
    overview: m.overview,
    spend: {
      tokens: { ...m.spend.total, inputSide: m.inputSideTokens, all: m.totalTokens },
      estimatedCostUsd: round2(m.spend.costUsd),
      costIsEstimate: true,
      unpricedModels: m.spend.unknownModels,
      perModel: Object.fromEntries(Object.entries(m.spend.perModel).map(([k, v]) => [k, { ...v, costUsd: round2(v.costUsd) }])),
    },
    avoidableInput: {
      estimatedTokens: m.avoidable.tokens,
      shareOfInputTokens: m.avoidable.shareOfInput,
      estimatedCostUsd: round2(m.avoidable.costUsd),
      costIsEstimate: true,
      carriedCostUsd: round2(m.avoidable.carriedCostUsd), carriedShareOfCacheReadSpend: m.avoidable.carriedShareOfCacheReadSpend, largeReads: m.avoidable.largeReads, redundantRereads: m.avoidable.redundantRereads, lowUseReads: m.avoidable.lowUseReads,
    },
    completionClaims: m.done,
    parsing: ctx.parsing,
  }, null, 2);
}
const round2 = (n) => Math.round(n * 100) / 100;

export function renderReport(m, ctx, { color = false } = {}) {
  const b = (s) => (color ? `\x1b[1m${s}\x1b[0m` : s);
  const d = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  const o = m.overview, L = [];
  L.push(b(`apex-context: last ${ctx.window}`), '');
  L.push(`${o.sessions} sessions (${o.from || '?'} to ${o.to || '?'}), ${fmtTokens(m.totalTokens)} tokens` +
    ` (about ${fmtUsd(m.spend.costUsd)}, estimate).`);
  L.push(d(`  input ${fmtTokens(m.spend.total.input)}, cache read ${fmtTokens(m.spend.total.cacheRead)}, cache write ${fmtTokens(m.spend.total.cacheCreate)}, output ${fmtTokens(m.spend.total.output)}`));
  for (const [k, v] of Object.entries(m.spend.perModel).sort((a, c) => (c[1].costUsd - a[1].costUsd) || (c[1].messages - a[1].messages))) {
    const t = v.input + v.cacheRead + v.cacheCreate + v.output;
    L.push(d(`  ${k}: ${fmtTokens(t)} tokens, ${v.priced ? '~' + fmtUsd(v.costUsd) + ' (estimate)' : 'no price on file'}`));
  }
  if (m.spend.unknownModels.length) L.push(d(`  Note: ${m.spend.unknownModels.length} model(s) have no price in the table and are left out of the dollar figures (use --prices).`));
  L.push('');
  const a = m.avoidable;
  L.push(b('Spends less?'));
  L.push(`About ${fmtTokens(a.tokens)} tokens (~${fmtUsd(a.costUsd)}, estimate) were large file reads the agent used little of` +
    (a.shareOfInput != null ? ` (${pct(a.shareOfInput)} of input-side tokens).` : '.'));
  L.push(d(`  ${a.largeReads} large whole-file reads; ${a.redundantRereads} unchanged re-reads, ${a.lowUseReads} reads with little use. Conservative; not a promise of savings.`));
  L.push('');
  L.push(d(`  Carried through later turns until compaction: about ${fmtUsd(a.carriedCostUsd)} (estimate), ${pct(a.carriedShareOfCacheReadSpend)} of cache-read spend. What a smaller context would cost less, not a guarantee.`));
  L.push('');
  const c = m.done;
  L.push(b("Can't fake done?"));
  if (!c.claims) L.push('No completion claims after code edits found in this window.');
  else {
    L.push(`${c.unchecked} of ${c.claims} completion claims (${pct(c.uncheckedShare)}) had nothing run after the last edit to check them.`);
    L.push(d(`  ${c.proven} proven by a passing test/typecheck/build, ${c.manual} manually checked (script, grep, browser), ${c.failed} where the last test failed.`));
  }
  L.push('');
  L.push(d(`Read-only and local: nothing left this machine. ${ctx.parsing.parsedPct}% of log lines parsed (${ctx.parsing.messagePct}% were conversation messages, the rest metadata). Run with --explain for formulas.`));
  return L.join('\n');
}

export function renderShare(m, ctx) {
  const c = m.done, a = m.avoidable;
  const L = [`My agent logs, last ${ctx.window} (apex-context):`];
  L.push(`- ${m.overview.sessions} sessions, ${fmtTokens(m.totalTokens)} tokens, about ${fmtUsd(m.spend.costUsd)} (estimate)`);
  L.push(`- ~${fmtTokens(a.tokens)} tokens (~${fmtUsd(a.costUsd)}, estimate) were large file reads the agent used little of`);
  if (c.claims) L.push(`- ${c.unchecked} of ${c.claims} "done" claims had nothing run after the last edit (${c.proven} proven by tests, ${c.manual} checked by hand)`);
  L.push('Estimates from local logs, conservative formulas. npx apex-context report');
  return L.join('\n');
}

// Never lists folders from the filesystem: project folder names can be sensitive.
const DEFAULT_LOCATION = { 'claude-code': '~/.claude/projects', 'gemini-cli': '~/.gemini/tmp' };
export function noLogsMessage(adapterName, customDir, window = '30d') {
  const label = adapterName === 'gemini-cli' ? 'Gemini CLI' : 'Claude Code';
  const where = customDir ? 'the folder given with --dir' : `the default ${label} log folder (${DEFAULT_LOCATION[adapterName] || 'default'})`;
  return [`No ${label} session logs found in the last ${window}.`, `Looked in ${where}.`,
    'Use --dir <path> to point at another folder, --since 90d for a longer window, or --agent gemini for Gemini CLI logs.'].join('\n');
}
