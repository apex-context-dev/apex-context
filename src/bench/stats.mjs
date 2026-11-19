// Statistics, written fresh. Everything is deterministic (seeded bootstrap) so a report can be regenerated exactly.
//
// Pass rate .......... Wilson 95% score interval over runs (treats runs as independent trials; see README limits).
// Paired comparison .. per task, majority pass (> 50% of that arm's runs; a tie counts as not passing).
//                      Exact McNemar test = two-sided exact binomial test (p = 0.5) on the discordant tasks
//                      (b = only A passes, c = only B passes). A sign test on per-task pass RATES (A higher vs lower,
//                      ties dropped) is reported alongside; it uses all runs, McNemar uses only the majority.
// Tokens / seconds ... median and mean with a percentile bootstrap 95% CI (resampling runs; seeded).
// False-ready ........ among runs where the arm's claimedDone is known and true, the share that fail hidden scoring
//                      (Wilson CI). n/a when no run has a known claim.

export const Z95 = 1.959964;

export function wilson(k, n, z = Z95) {
  if (!n) return [null, null];
  const p = k / n, z2 = z * z, d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const logChoose = (n, k) => { let s = 0; for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i); return s; };

/** Two-sided exact binomial p-value for k successes in n trials under p = 0.5 (doubled tail, capped at 1). */
export function binomTwoSided(k, n) {
  if (n === 0) return 1;
  const lo = Math.min(k, n - k);
  let p = 0;
  for (let i = 0; i <= lo; i++) p += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * p);
}
export const mcnemarExact = (b, c) => binomTwoSided(b, b + c);
export const signTest = (up, down) => binomTwoSided(up, up + down);

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Percentile bootstrap 95% CI of stat(values). Seeded. One value -> degenerate interval. */
export function bootstrapCI(values, stat = mean, { B = 5000, seed = 1 } = {}) {
  if (!values.length) return [null, null];
  if (values.length === 1) return [values[0], values[0]];
  const rnd = mulberry32(seed), n = values.length, out = [];
  const buf = new Array(n);
  for (let b = 0; b < B; b++) { for (let i = 0; i < n; i++) buf[i] = values[Math.floor(rnd() * n)]; out.push(stat(buf)); }
  out.sort((x, y) => x - y);
  return [out[Math.floor(0.025 * B)], out[Math.min(B - 1, Math.ceil(0.975 * B) - 1)]];
}

const known = (xs) => xs.filter((x) => x != null);

export function summarizeArm(rows, { seed = 1, B = 5000 } = {}) {
  const n = rows.length, passes = rows.filter((r) => r.pass).length;
  const total = known(rows.map((r) => (r.tokensIn != null && r.tokensOut != null ? r.tokensIn + r.tokensOut : null)));
  const tin = known(rows.map((r) => r.tokensIn)), tout = known(rows.map((r) => r.tokensOut));
  const secs = rows.map((r) => r.seconds);
  const claim = rows.filter((r) => r.claimedDone != null), claimed = claim.filter((r) => r.claimedDone);
  const fr = claimed.filter((r) => !r.pass).length;
  const dist = (xs) => ({ n: xs.length, median: median(xs), mean: mean(xs), medianCI: bootstrapCI(xs, median, { B, seed }), meanCI: bootstrapCI(xs, mean, { B, seed }) });
  return {
    runs: n, tasks: new Set(rows.map((r) => r.taskId)).size, passes, passRate: n ? passes / n : null, passCI: wilson(passes, n),
    tokensTotal: total.length ? dist(total) : null, tokensIn: tin.length ? { n: tin.length, median: median(tin), mean: mean(tin) } : null, tokensOut: tout.length ? { n: tout.length, median: median(tout), mean: mean(tout) } : null,
    seconds: dist(secs),
    falseReady: claim.length ? { knownRuns: claim.length, claimedDone: claimed.length, falseReady: fr, rate: claimed.length ? fr / claimed.length : null, ci: wilson(fr, claimed.length) } : null,
    timeouts: rows.filter((r) => r.timedOut).length, suspended: rows.filter((r) => r.suspended).length, agentNonZeroExit: rows.filter((r) => r.exitCode !== 0 && !r.timedOut).length,
  };
}

function perTaskRates(rows) {
  const m = new Map();
  for (const r of rows) { if (!m.has(r.taskId)) m.set(r.taskId, []); m.get(r.taskId).push(r.pass ? 1 : 0); }
  return new Map([...m].map(([t, xs]) => [t, mean(xs)]));
}

/** Paired comparison of arm A against baseline B over the tasks both have run. */
export function pairedCompare(rowsA, rowsB, { seed = 1, B = 5000 } = {}) {
  const ra = perTaskRates(rowsA), rb = perTaskRates(rowsB);
  const shared = [...ra.keys()].filter((t) => rb.has(t)).sort();
  let b = 0, c = 0, up = 0, down = 0;
  const diffs = [];
  for (const t of shared) {
    const a = ra.get(t), z = rb.get(t);
    const am = a > 0.5, zm = z > 0.5;
    if (am && !zm) b++; else if (!am && zm) c++;
    if (a > z) up++; else if (a < z) down++;
    diffs.push(a - z);
  }
  const pMcNemar = mcnemarExact(b, c), pSign = signTest(up, down);
  const verdict = pMcNemar < 0.05 ? (b > c ? "A better" : "B better") : "no significant difference";
  return {
    tasks: shared.length, onlyAPasses: b, onlyBPasses: c, pMcNemar, ratesUp: up, ratesDown: down, pSign,
    meanPassRateDiff: mean(diffs), diffCI: bootstrapCI(diffs, mean, { B, seed }), verdict,
    underpowered: b + c < 6, // with fewer than 6 discordant tasks the exact test cannot reach p < 0.05
  };
}

/** rows -> {arms:{name:summary}, baseline, pairs:[{arm, baseline, ...}], warnings}. */
export function summarize(rows, { baseline, seed = 1, B = 5000 } = {}) {
  const names = [...new Set(rows.map((r) => r.arm))];
  const by = Object.fromEntries(names.map((n) => [n, rows.filter((r) => r.arm === n)]));
  const base = baseline && by[baseline] ? baseline : (names.includes("noop") ? "noop" : names[0]);
  const arms = Object.fromEntries(names.map((n) => [n, summarizeArm(by[n], { seed, B })]));
  const pairs = names.filter((n) => n !== base).map((n) => ({ arm: n, baseline: base, ...pairedCompare(by[n], by[base], { seed, B }) }));
  const warnings = [];
  const hashes = new Set(rows.map((r) => `${r.taskId}:${r.taskHash}`));
  if (hashes.size > new Set(rows.map((r) => r.taskId)).size) warnings.push("rows come from more than one version of some task (task hashes differ); do not mix them.");
  const counts = names.map((n) => arms[n].runs);
  if (new Set(counts).size > 1) warnings.push(`arms have different run counts (${names.map((n) => `${n}=${arms[n].runs}`).join(", ")}); runs may be incomplete.`);
  for (const n of names) {
    if (arms[n].suspended) warnings.push(`${arms[n].suspended} run(s) of ${n} suspended (machine slept); their seconds are unreliable.`);
    if (arms[n].tokensTotal && arms[n].tokensTotal.n < arms[n].runs) warnings.push(`${n}: tokens known for ${arms[n].tokensTotal.n} of ${arms[n].runs} runs only.`);
  }
  for (const p of pairs) if (p.underpowered) warnings.push(`${p.arm} vs ${p.baseline}: only ${p.onlyAPasses + p.onlyBPasses} discordant task(s); the exact test cannot reach p < 0.05. Add tasks, not just runs.`);
  return { arms, baseline: base, pairs, warnings, runs: rows.length };
}

// ---------- rendering ----------
const pct = (x) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);
const ci = (c, f) => (c[0] == null ? "" : ` [${f(c[0])}, ${f(c[1])}]`);
const int = (x) => (x == null ? "n/a" : Math.round(x).toLocaleString("en-US"));
const p3 = (p) => (p < 0.001 ? "<0.001" : p.toFixed(3));

function armRow(name, a) {
  return [
    name, String(a.runs), `${a.passes}/${a.runs} ${pct(a.passRate)}${ci(a.passCI, pct)}`,
    a.tokensTotal ? `${int(a.tokensTotal.median)}${ci(a.tokensTotal.medianCI, int)}` : "n/a",
    `${a.seconds.median.toFixed(2)}${ci(a.seconds.medianCI, (x) => x.toFixed(2))}`,
    a.falseReady ? `${a.falseReady.falseReady}/${a.falseReady.claimedDone} ${pct(a.falseReady.rate)}${a.falseReady.claimedDone ? ci(a.falseReady.ci, pct) : ""}` : "n/a",
  ];
}
const HEAD = ["Arm", "Runs", "Pass (95% CI)", "Tokens median [95% CI]", "Seconds median [95% CI]", "False-ready"];

export function renderTable(s) {
  const rows = [HEAD, ...Object.entries(s.arms).map(([n, a]) => armRow(n, a))];
  const w = HEAD.map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(w[i])).join("  ");
  const out = [line(rows[0]), w.map((x) => "-".repeat(x)).join("  "), ...rows.slice(1).map(line)];
  if (s.pairs.length) {
    out.push("", `Paired vs ${s.baseline} (per task; exact McNemar on majority pass, sign test on pass rates):`);
    for (const p of s.pairs) out.push(`  ${p.arm}: ${p.tasks} tasks, only-${p.arm} ${p.onlyAPasses} / only-${s.baseline} ${p.onlyBPasses}, McNemar p=${p3(p.pMcNemar)}, sign p=${p3(p.pSign)}, mean diff ${p.meanPassRateDiff == null ? "n/a" : (p.meanPassRateDiff * 100).toFixed(0) + " pts"}${ci(p.diffCI, (x) => (x * 100).toFixed(0))} -> ${p.verdict.replace("A better", `${p.arm} better`).replace("B better", `${s.baseline} better`)}${p.underpowered ? " (underpowered)" : ""}`);
  }
  for (const w2 of s.warnings) out.push(`warning: ${w2}`);
  return out.join("\n");
}

export function renderMarkdown(s, { title = "apex-context bench report", meta = {} } = {}) {
  const md = [`# ${title}`, ""];
  if (meta.setHash) md.push(`Task set \`${meta.setHash}\`, ${s.runs} runs. ${meta.machine ? `Machine: ${meta.machine.os}, ${meta.machine.cpu}, ${meta.machine.memGB} GB, node ${meta.machine.node}.` : ""}`, "");
  md.push(`| ${HEAD.join(" | ")} |`, `|${HEAD.map(() => "---").join("|")}|`);
  for (const [n, a] of Object.entries(s.arms)) md.push(`| ${armRow(n, a).join(" | ")} |`);
  if (s.pairs.length) {
    md.push("", `## Paired comparison vs \`${s.baseline}\``, "", "| Arm | Tasks | Only arm passes | Only baseline passes | McNemar p | Sign p | Mean diff (pts) | Verdict |", "|---|---|---|---|---|---|---|---|");
    for (const p of s.pairs) md.push(`| ${p.arm} | ${p.tasks} | ${p.onlyAPasses} | ${p.onlyBPasses} | ${p3(p.pMcNemar)} | ${p3(p.pSign)} | ${p.meanPassRateDiff == null ? "n/a" : (p.meanPassRateDiff * 100).toFixed(0)}${ci(p.diffCI, (x) => (x * 100).toFixed(0))} | ${p.verdict.replace("A better", `${p.arm} better`).replace("B better", `${s.baseline} better`)}${p.underpowered ? " (underpowered)" : ""} |`);
  }
  if (s.warnings.length) md.push("", "## Warnings", "", ...s.warnings.map((w) => `- ${w}`));
  md.push("", "## How to read this", "",
    "- Pass is hidden tests (and visible tests, if the task has them) exiting 0 after the agent stops. Pass-rate CI is a Wilson interval over runs.",
    "- False-ready = the agent claimed it was done and the hidden tests still failed, among runs where the claim is known. `n/a` means the arm cannot tell, not zero.",
    "- Tokens are whatever the agent CLI reports about itself (`n/a` if it reports nothing); cached tokens may or may not be included. Compare tokens only between arms that count the same way.",
    "- Small task sets cannot separate close arms: see the underpowered warnings and the README limits.", "");
  return md.join("\n");
}
