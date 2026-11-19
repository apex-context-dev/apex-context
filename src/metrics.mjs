// Metrics over normalized sessions. Pure functions, no I/O. Formulas are
// deliberately conservative (they err low) and are printed by `report --explain`.

import path from 'node:path';

export const LARGE_READ_CHARS = 4000;
export const CHARS_PER_TOKEN = 4;
export const MARGIN_BASE = 0.25;      // keep this share of a read as "context margin"
export const MARGIN_SLOPE = 4;        // plus 4x the share of lines actually edited
export const UNUSED_READ_FRACTION = 0.5; // never edited, never mentioned again: count half

// ---------- prices ----------

/** Model names come from logs: print only ones that look like model ids. */
export const safeModel = (m) => (typeof m === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,59}$/.test(m) ? m : 'other-model');

/** Longest-prefix match of a model name in the price table. */
export function priceFor(model, table) {
  if (!model) return null;
  let best = null;
  for (const k of Object.keys(table.models || {})) {
    if (model.startsWith(k) && (!best || k.length > best.length)) best = k;
  }
  return best ? table.models[best] : null;
}

export function costOf(usage, p) {
  return (usage.input * p.input + usage.output * p.output +
    usage.cacheRead * p.cacheRead + usage.cacheCreate * p.cacheWrite) / 1e6;
}

// ---------- A. spend ----------

export function computeSpend(sessions, prices) {
  const perModel = {};
  const total = { input: 0, cacheRead: 0, cacheCreate: 0, output: 0 };
  let cost = 0;
  const unknownModels = new Set();
  for (const s of sessions) {
    for (const t of s.turns) {
      if (t.role !== 'assistant' || !t.usage) continue;
      const model = t.model ? safeModel(t.model) : 'unknown';
      if (model === '<synthetic>') continue;
      const m = perModel[model] || (perModel[model] = { input: 0, cacheRead: 0, cacheCreate: 0, output: 0, messages: 0, costUsd: 0, priced: false });
      m.messages++;
      for (const k of Object.keys(total)) { m[k] += t.usage[k]; total[k] += t.usage[k]; }
    }
  }
  for (const [model, m] of Object.entries(perModel)) {
    const p = priceFor(model, prices);
    if (p) { m.priced = true; m.costUsd = costOf(m, p); cost += m.costUsd; } else unknownModels.add(model);
  }
  return { total, perModel, costUsd: cost, unknownModels: [...unknownModels] };
}

// ---------- B. avoidable input ----------

const base = (f) => path.basename(f);
function mentions(call, file) {
  if (!call.refs) return false;
  return call.refs.includes(file) || call.refs.includes(base(file));
}

/**
 * For each large whole-file Read result, estimate the tokens that likely did not
 * need to be sent. See EXPLAIN text for the formula.
 */
export function computeAvoidable(sessions, prices) {
  const out = { tokens: 0, costUsd: 0, reads: 0, largeReads: 0, redundantRereads: 0, lowUseReads: 0, perModel: {}, unpricedTokens: 0, carriedTokenCalls: 0, carriedCostUsd: 0 };
  for (const s of sessions) {
    /** @type {{call:any, model:string|null}[]} */
    const seq = [];
    const calls = []; // one entry per model call (assistant message): cache-read size + model
    for (const t of s.turns) {
      if (t.role === 'assistant') calls.push({ cr: t.usage ? t.usage.cacheRead : 0, model: t.model });
      for (const c of t.toolCalls) seq.push({ call: c, model: t.model, a: calls.length - 1 });
    }
    const lastWhole = new Map(); // file -> index of previous whole read
    for (let i = 0; i < seq.length; i++) {
      const { call, model, a } = seq[i];
      if (call.kind !== 'read' || !call.file) continue;
      out.reads++;
      const f = call.file;
      const prev = lastWhole.get(f);
      if (call.whole && !call.result?.isError) lastWhole.set(f, i);
      if (!call.whole || !call.result || call.result.isError || call.result.chars <= LARGE_READ_CHARS) continue;
      out.largeReads++;
      const tokens = call.result.chars / CHARS_PER_TOKEN;
      let frac = 0;

      // re-read of an unchanged file?
      let redundant = false;
      if (prev != null) {
        redundant = true;
        for (let k = prev + 1; k < i; k++) {
          const c = seq[k].call;
          if ((c.file === f && (c.kind === 'edit' || c.kind === 'write')) ||
              ((c.kind === 'bash' || c.kind === 'edit' || c.kind === 'write') && mentions(c, f))) { redundant = false; break; }
        }
      }
      if (redundant) { frac = 1; out.redundantRereads++; }
      else {
        // window: until the next read of the same file
        let end = seq.length;
        for (let k = i + 1; k < seq.length; k++) if (seq[k].call.kind === 'read' && seq[k].call.file === f) { end = k; break; }
        let editedLines = 0, rewritten = false, edited = false;
        for (let k = i + 1; k < end; k++) {
          const c = seq[k].call;
          if (c.file !== f) continue;
          if (c.kind === 'write') rewritten = true;
          if (c.kind === 'edit') { edited = true; editedLines += c.oldLines || 1; }
        }
        if (rewritten) frac = 0;
        else if (edited) {
          const lines = Math.max(1, call.result.lines);
          frac = Math.max(0, 1 - (MARGIN_BASE + MARGIN_SLOPE * (editedLines / lines)));
        } else {
          let referenced = false;
          for (let k = i + 1; k < seq.length && !referenced; k++) {
            const c = seq[k].call;
            if (c.kind === 'read' && c.file === f) continue;
            if (c.file === f || mentions(c, f)) referenced = true;
          }
          frac = referenced ? 0 : UNUSED_READ_FRACTION;
        }
        if (frac > 0) out.lowUseReads++;
      }
      if (frac <= 0) continue;
      const av = tokens * frac;
      out.tokens += av;
      // carried context: later model calls until a likely compaction (cache-read size drops by > 50%)
      for (let k = a + 1; k < calls.length; k++) {
        if (calls[k - 1].cr > 0 && calls[k].cr < calls[k - 1].cr * 0.5) break;
        out.carriedTokenCalls += av;
        const cp = priceFor(calls[k].model, prices);
        if (cp) out.carriedCostUsd += av * cp.cacheRead / 1e6;
      }
      const mk = model ? safeModel(model) : 'unknown';
      const pm = out.perModel[mk] || (out.perModel[mk] = { tokens: 0, costUsd: 0 });
      pm.tokens += av;
      const p = priceFor(model, prices);
      if (p) { const c = av * p.input / 1e6; pm.costUsd += c; out.costUsd += c; } else out.unpricedTokens += av;
    }
  }
  out.tokens = Math.round(out.tokens);
  out.carriedTokenCalls = Math.round(out.carriedTokenCalls);
  return out;
}

// ---------- C. unproven done ----------

const TEST_RE = new RegExp([
  String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w:.-]*(?:test|typecheck|type-check|lint|build|check)[\w:.-]*\b`,
  String.raw`\b(?:npx\s+)?(?:pytest|py\.test|jest|vitest|mocha|tsc|eslint|mypy|ruff|pyright|playwright\s+test|cypress\s+run)\b`,
  String.raw`\bpython3?\s+-m\s+(?:pytest|unittest|mypy|ruff)\b`,
  String.raw`\bgo\s+(?:test|vet|build)\b`,
  String.raw`\bcargo\s+(?:test|check|build|clippy)\b`,
  String.raw`\bnode\s+(?:[\w=./-]+\s+)*--test\b`,
  String.raw`\bnode\s+\S*\.test\.\w+`,
  String.raw`\b(?:mvn|mvnw|\./mvnw)\b.*\b(?:test|verify|package)\b`,
  String.raw`\b(?:gradle|gradlew|\./gradlew)\b.*\b(?:test|check|build)\b`,
  String.raw`\bmake\s+(?:test|check|lint|build)\b`,
  String.raw`\bxcodebuild\b.*\b(?:test|build)\b`,
  String.raw`\bswift\s+(?:test|build)\b`,
  String.raw`\bdotnet\s+(?:test|build)\b`,
].join('|'), 'i');

export const isTestCommand = (cmd) => !!cmd && TEST_RE.test(cmd);

const FAIL_PATTERNS = [
  /\bFAIL(?:ED|URE)?\b/,
  /\b[1-9]\d*\s+(?:failed|failing|errors?)\b/i,
  /#\s*fail\s+[1-9]/i,
  /\berror\s+TS\d+/i,
  /\bAssertionError\b/,
  /\bnpm ERR!/,
  /\bBUILD FAILED\b/i,
  /^\s*Exit code [1-9]/m,
  /\bTraceback \(most recent call last\)/,
  /✗|✖/,
];
export function looksFailed(result, cmd = '') {
  if (!result) return false;
  if (result.isError || (result.exitCode != null && result.exitCode !== 0)) return true;
  // a recorded exit status of 0 is trusted unless the command pipes (a pipe can hide the runner's status)
  if (result.exitCode === 0 && !/\|(?!\|)/.test(cmd)) return false;
  const t = result.tail || '';
  return FAIL_PATTERNS.some((re) => re.test(t));
}

const CLAIM_RE = /\b(done|fixed|implemented|complete[d]?|all set|passing|works now|working now|finished|resolved)\b/gi;
const NEG_RE = /(?:\bnot|n't|\bnever|\bno longer)\W{0,3}(?:\w+\W+){0,2}$/i;
export const CLAIM_WINDOW = 300;
/** English only. Returns the matched claim word (lowercase) or null. Looks at the last 300 chars. */
export function claimWord(text) {
  if (!text) return null;
  const t = text.slice(-CLAIM_WINDOW);
  CLAIM_RE.lastIndex = 0;
  let m;
  while ((m = CLAIM_RE.exec(t))) {
    if (!NEG_RE.test(t.slice(Math.max(0, m.index - 24), m.index))) return m[1].toLowerCase();
  }
  return null;
}
export const claimsDone = (text) => claimWord(text) != null;

// Bash commands that change files (conservative list)
const BASH_EDIT_RES = [
  /\bsed\s+(?:-[a-zA-Z]*\s+)*(?:-[a-zA-Z]*i|--in-place)/,
  /\bperl\s+(?:-\w+\s+)*-\w*i/,
  /\btee\b(?!\s+(?:-a\s+)?(?:\/dev\/|\/tmp\/|\/private\/))/,
  /\bgit\s+(?:apply|restore|checkout\s+(?:--\s|\S+\s+--\s))/,
  /\b(?:writeFileSync|appendFileSync|write_text|write_bytes|shutil\.(?:copy|move))\b|\bopen\([^)]*['"][wa]b?['"]/,
  /\b(?:mv|cp)\s+\S+\s+\S*\.(?:m?[jt]sx?|py|json|md|css|html|go|rs|swift)\b/,
];
const REDIRECT_RE = /(?:^|[\s;&|])\d?>>?\s*(?!&)(["']?)([^\s;&|"']+)/g;
export function isBashEdit(cmd) {
  if (!cmd) return false;
  if (BASH_EDIT_RES.some((re) => re.test(cmd))) return true;
  REDIRECT_RE.lastIndex = 0;
  let m;
  while ((m = REDIRECT_RE.exec(cmd))) {
    const tgt = m[2];
    if (/^(?:\/dev\/|\/tmp\/|\/private\/|\$TMP|&)/.test(tgt) || /\.(?:log|out|err)$/.test(tgt)) continue;
    return true;
  }
  return false;
}
export const isEditCall = (c) => c.kind === 'edit' || c.kind === 'write' || (c.kind === 'bash' && isBashEdit(c.command));

const MANUAL_BASH_RE = /\b(?:node|python3?|curl|grep|rg|ruby|bash|sh|osascript|xcrun|simctl|open)\b|(?:^|[\s;&|])\.\/\S+/;
const VISUAL_TOOL_RE = /Browser|Simulator|chrome|playwright|puppeteer/i;
export function checkKind(c) {
  if (c.kind === 'bash') {
    if (isEditCall(c)) return null;
    if (isTestCommand(c.command)) return 'test';
    return MANUAL_BASH_RE.test(c.command || '') ? 'manual' : null;
  }
  if (c.kind === 'other' && VISUAL_TOOL_RE.test(c.name)) return 'manual';
  return null;
}
const label = (c) => {
  if (c.kind !== 'bash') return c.name;
  if (isEditCall(c)) return 'Bash:edit';
  const k = checkKind(c);
  return k ? 'Bash:' + k : 'Bash';
};

/**
 * One record per user-visible turn (prompt -> next prompt) that contains an edit.
 * cls: proven | manual | failed | unchecked, or null when the turn ends without a claim.
 */
export function analyzeSegments(sessions) {
  const recs = [];
  for (const s of sessions) {
    if (s.isSubagentFile) continue;
    const turns = s.turns.filter((t) => !t.sidechain);
    const segs = [];
    let cur = null;
    for (const t of turns) {
      if (t.role === 'user' && t.isPrompt) { cur = []; segs.push(cur); }
      else { if (!cur) { cur = []; segs.push(cur); } cur.push(t); }
    }
    segs.forEach((seg, idx) => {
      const calls = [];
      let last = null;
      for (const t of seg) { if (t.role !== 'assistant') continue; for (const c of t.toolCalls) calls.push(c); last = t; }
      let lastEdit = -1;
      calls.forEach((c, i) => { if (isEditCall(c)) lastEdit = i; });
      if (lastEdit < 0) return;
      const word = last && !last.toolCalls.length ? claimWord(last.textTail) : null;
      const after = calls.slice(lastEdit + 1);
      let cls = null;
      if (word) {
        const tests = after.filter((c) => checkKind(c) === 'test');
        if (tests.length) cls = looksFailed(tests[tests.length - 1].result, tests[tests.length - 1].command) ? 'failed' : 'proven';
        else if (after.some((c) => checkKind(c) === 'manual')) cls = 'manual';
        else cls = 'unchecked';
      }
      recs.push({ session: s.id, index: idx, tools: after.map(label), editCalls: calls.filter(isEditCall).length, claim: word, cls });
    });
  }
  return recs;
}

export function computeDone(sessions) {
  const r = { claims: 0, proven: 0, manual: 0, failed: 0, unchecked: 0, segmentsWithEdits: 0, segmentsNoClaim: 0, sessionsWithClaims: 0 };
  const sess = new Set();
  for (const x of analyzeSegments(sessions)) {
    r.segmentsWithEdits++;
    if (!x.cls) { r.segmentsNoClaim++; continue; }
    r.claims++; r[x.cls]++; sess.add(x.session);
  }
  r.sessionsWithClaims = sess.size;
  const share = (n) => (r.claims ? n / r.claims : null);
  r.uncheckedShare = share(r.unchecked); r.provenShare = share(r.proven);
  r.manualShare = share(r.manual); r.failedShare = share(r.failed);
  return r;
}

// ---------- D. overview ----------

export function computeOverview(sessions) {
  const real = sessions.filter((s) => !s.isSubagentFile);
  let min = null, max = null;
  for (const s of sessions) {
    if (s.firstTs != null) min = min == null ? s.firstTs : Math.min(min, s.firstTs);
    if (s.lastTs != null) max = max == null ? s.lastTs : Math.max(max, s.lastTs);
  }
  return {
    sessions: real.length, subagentFiles: sessions.length - real.length,
    from: min ? new Date(min).toISOString().slice(0, 10) : null,
    to: max ? new Date(max).toISOString().slice(0, 10) : null,
  };
}

export function computeAll(sessions, prices) {
  const spend = computeSpend(sessions, prices);
  const avoidable = computeAvoidable(sessions, prices);
  const inputSide = spend.total.input + spend.total.cacheRead + spend.total.cacheCreate;
  avoidable.shareOfInput = inputSide ? avoidable.tokens / inputSide : null;
  let crCost = 0;
  for (const [k, v] of Object.entries(spend.perModel)) { const p = priceFor(k, prices); if (p) crCost += v.cacheRead * p.cacheRead / 1e6; }
  avoidable.carriedShareOfCacheReadSpend = crCost ? avoidable.carriedCostUsd / crCost : null;
  return {
    overview: computeOverview(sessions),
    spend, avoidable, done: computeDone(sessions),
    inputSideTokens: inputSide,
    totalTokens: inputSide + spend.total.output,
  };
}

export const EXPLAIN = `How the numbers are computed (all are estimates; formulas err low)

SPEND
  Tokens come from the usage block of each assistant message in your logs
  (input, cache read, cache write, output). A message logged in several pieces
  is counted once (largest value per field). Dollars = tokens x the per-model
  rate in src/prices.json (longest model-name prefix wins). Models with no rate
  are shown but excluded from dollars. Cache writes use the 5-minute rate.
  Override rates with --prices <file>. Every dollar figure is an estimate and
  can differ from your invoice.

AVOIDABLE INPUT ("large file reads the agent used little of")
  Only whole-file Read results larger than ${LARGE_READ_CHARS} characters are considered
  (about ${CHARS_PER_TOKEN} characters per token). Each such read gets an avoidable share:
    - Re-read of the same file in the same session with no edit, write or shell
      command mentioning the file in between: 100% of the second read.
    - Otherwise, if the agent edited the file before reading it again:
      edited = lines in the Edit old_string / lines in the file
      share = max(0, 1 - (${MARGIN_BASE} + ${MARGIN_SLOPE} x edited))   (zero once edits touch >= ${Math.round((1 - MARGIN_BASE) / MARGIN_SLOPE * 100)}% of the file)
      A Write that rewrites the whole file counts as fully used.
    - If never edited and never mentioned again in the session: ${UNUSED_READ_FRACTION * 100}% of the read
      (it may have informed the agent's reasoning, so only half is counted).
    - If never edited but mentioned later (search, shell, other edit): 0%.
  Tokens are counted once, at the moment they were sent. Later turns re-send them
  from cache; that is NOT counted, which keeps the figure low. Dollars use the
  model's plain input rate. The share is avoidable tokens / all input-side tokens
  (input + cache read + cache write). This is what the logs suggest, not a promise
  of what any tool would save.

CARRIED CONTEXT (what a smaller context would cost less)
  A file read stays in the context window and is re-sent from cache on every later
  model call. For each read with an avoidable share (above):
    carried tokens x calls = avoidable tokens x number of later model calls in the
    same session, until a likely compaction (a call whose cache-read size is less
    than half the previous call's).
  Dollars = that, priced at each later call's model cache-read rate. Reported as a
  share of total cache-read spend. Only the avoidable share is carried, compaction
  stops the count early, and cache-read is the cheapest rate, so this errs low. It
  estimates what a smaller context would have cost less; it is not a guarantee.

COMPLETION CLAIMS AND VERIFICATION CLASSES
  Each user-visible turn (one prompt to the next) that contains at least one
  edit and ends with a text-only assistant message is examined. Edits are
  Edit/Write/MultiEdit/NotebookEdit plus Bash commands that change files (sed -i,
  perl -i, tee, redirects into files other than logs or /tmp, git apply/restore/
  checkout of files, scripts calling write functions, mv/cp onto source files).
  It is a CLAIM if the last ${CLAIM_WINDOW} characters of that message contain, in English,
  done, fixed, implemented, complete(d), all set, passing, works now, finished or
  resolved (not preceded by a negation such as "not" or "n't"). Bare "ready" and
  "passes" are not counted. Then, looking only at calls after the last edit:
    PROVEN           a test/typecheck/lint/build command ran (npm/pnpm/yarn test|
                     lint|build, pytest, go test, cargo test, tsc, node --test, jest,
                     vitest, mvn, gradle, make test, ...) and the last one did not fail
    FAILED           the last such command failed
    MANUALLY CHECKED no such command, but a node/python/curl/grep/script/shell
                     command or a browser/simulator tool ran
    UNCHECKED        nothing like the above ran after the last edit
  Failure = recorded non-zero exit status or error flag; a recorded exit status of
  0 is trusted unless the command pipes (then text such as FAIL, "3 failed",
  error TSxxxx is also checked). The headline number is the UNCHECKED share.
  Turns with no edits or without a claim are excluded. A check made in a different
  turn, or by a command the patterns miss, is not seen.
`;
