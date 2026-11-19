// Pluggable extraction of token usage and the "claimed done" signal from an agent run.
// Everything here is self-reported by the agent CLI; nothing is measured independently.
import fs from "node:fs";

const getPath = (obj, p) => String(p).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const num = (v) => { const n = typeof v === "string" ? Number(v.replace(/,/g, "")) : v; return Number.isFinite(n) ? n : null; };
const textOf = (spec, r) => (spec.source === "stdout" ? r.stdout : spec.source === "stderr" ? r.stderr : `${r.stdout}\n${r.stderr}`);

function readJson(spec, r) {
  const file = spec.file ?? "stdout";
  if (file === "stdout" || file === "stderr") {
    const txt = r[file].trim();
    try { return JSON.parse(txt); } catch { /* try last JSON line */ }
    for (const line of txt.split("\n").reverse()) { try { return JSON.parse(line); } catch { /* next */ } }
    return null;
  }
  const f = file.replaceAll("{outDir}", r.outDir);
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}

function regexNumbers(pattern, text, mode) {
  if (!pattern) return null;
  const hits = [...text.matchAll(new RegExp(pattern, "gm"))].map((m) => num(m[1])).filter((n) => n != null);
  if (!hits.length) return null;
  return mode === "sum" ? hits.reduce((a, b) => a + b, 0) : hits[hits.length - 1];
}

function sumPaths(obj, paths) {
  if (!paths) return null;
  const vals = [].concat(paths).map((p) => num(getPath(obj, p))).filter((n) => n != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}

/**
 * spec: undefined -> n/a; {type:"regex", in, out, source, mode:"last"|"sum"} (first capture group is the number);
 * {type:"json", file:"stdout"|"{outDir}/usage.json", in:"a.b" | ["a.b","a.c"] (summed), out: ...}.
 * Returns {tokensIn, tokensOut}, each a number or null.
 */
export function extractUsage(spec, r) {
  const none = { tokensIn: null, tokensOut: null };
  if (!spec) return none;
  if (spec.type === "regex") { const t = textOf(spec, r); return { tokensIn: regexNumbers(spec.in, t, spec.mode), tokensOut: regexNumbers(spec.out, t, spec.mode) }; }
  if (spec.type === "json") { const j = readJson(spec, r); return j == null ? none : { tokensIn: sumPaths(j, spec.in), tokensOut: sumPaths(j, spec.out) }; }
  throw new Error(`unknown readUsage type ${spec.type}`);
}

/**
 * Did the agent say it was done? true / false, or null when the arm has no way to tell (never guessed).
 * spec: {type:"regex", pattern, source} (no match -> false) or {type:"json", file, field, equals?} (unreadable -> null).
 */
export function detectClaimedDone(spec, r) {
  if (!spec) return null;
  if (spec.type === "regex") return new RegExp(spec.pattern, "m").test(textOf(spec, r));
  if (spec.type === "json") {
    const j = readJson(spec, r);
    if (j == null) return null;
    const v = getPath(j, spec.field);
    if (v === undefined) return null;
    return "equals" in spec ? v === spec.equals : Boolean(v);
  }
  throw new Error(`unknown claimedDone type ${spec.type}`);
}
