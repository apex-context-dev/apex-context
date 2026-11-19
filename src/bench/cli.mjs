import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { builtinArms } from "./arms.mjs";
import { loadArmsFile } from "./tasks.mjs";
import { runBench, machine } from "./runner.mjs";
import { summarize, renderTable, renderMarkdown } from "./stats.mjs";
import { validateAll } from "./validate.mjs";
import { readJsonl } from "./util.mjs";
import { HELP } from "./help.mjs";

const BOOL = new Set(["dry", "resume", "json", "keep", "fresh", "help"]);
export function parseArgs(argv) {
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const [k, v] = a.slice(2).split(/=(.*)/s);
    if (v !== undefined) flags[k] = v; else if (BOOL.has(k)) flags[k] = true; else flags[k] = argv[++i];
  }
  return { flags, pos };
}


const num = (v) => (v === undefined ? undefined : Number(v));

export async function main(argv, io = { out: console.log, err: console.error }) {
  const { flags, pos } = parseArgs(argv);
  const cmd = pos.shift();
  if (!cmd || flags.help || cmd === "help") { io.out(HELP); return 0; }

  if (cmd === "validate") {
    if (!pos[0]) throw new Error("usage: apex-context bench validate <taskDir>");
    const res = await validateAll(pos[0]);
    for (const r of res) io.out(`${r.ok ? "ok  " : "FAIL"} ${path.basename(r.dir)}${r.problems.length ? "  " + r.problems.join("; ") : ""}${r.notes?.length ? `  (note: ${r.notes.join("; ")})` : ""}`);
    io.out(`\n${res.filter((r) => r.ok).length}/${res.length} tasks valid`);
    return res.every((r) => r.ok) ? 0 : 1;
  }

  if (cmd === "demo") {
    // Runs the bundled example tasks with the built-in arms: no API key, works from an npx or unpacked copy.
    const tasksDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../examples/bench/tasks");
    const res = await validateAll(tasksDir);
    io.out(`${res.filter((r) => r.ok).length}/${res.length} example tasks valid`);
    if (!res.every((r) => r.ok)) return 1;
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-context-bench-demo-"));
    await runBench({ tasksDir, armNames: ["oracle", "noop", "liar"], armDefs: builtinArms(), runs: 2, outDir, log: io.err });
    return report(outDir, {}, io);
  }

  if (cmd === "report") {
    if (!pos[0]) throw new Error("usage: apex-context bench report <outDir>");
    return report(pos[0], flags, io);
  }

  if (cmd === "run") {
    if (!pos[0]) throw new Error("usage: apex-context bench run <tasksDir> --arms a,b");
    const armDefs = { ...builtinArms(), ...(flags["arms-file"] ? await loadArmsFile(flags["arms-file"]) : {}) };
    const armNames = String(flags.arms ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!armNames.length) throw new Error(`--arms is required (known: ${Object.keys(armDefs).join(", ")})`);
    const outDir = path.resolve(flags.out ?? "bench-out");
    if (flags.fresh && !flags.dry) for (const f of ["results.jsonl", "manifest.json", "report.md", "report.json", "runs"]) fs.rmSync(path.join(outDir, f), { recursive: true, force: true });
    const res = await runBench({
      tasksDir: path.resolve(pos[0]), armNames, armDefs, runs: num(flags.runs) ?? 1, filter: flags.tasks, outDir, resume: !!flags.resume, dry: !!flags.dry,
      concurrency: num(flags.concurrency) ?? 1, seed: num(flags.seed), temperature: num(flags.temperature), timeoutOverride: num(flags.timeout), keep: !!flags.keep, log: io.err,
    });
    if (flags.dry) return 0;
    return report(outDir, flags, io);
  }
  throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
}

function report(outDir, flags, io) {
  const dir = path.resolve(outDir);
  const rows = readJsonl(path.join(dir, "results.jsonl"));
  if (!rows.length) throw new Error(`no rows in ${path.join(dir, "results.jsonl")}`);
  const s = summarize(rows, { baseline: flags.baseline });
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")); } catch { /* optional */ }
  const md = renderMarkdown(s, { meta: { setHash: manifest.setHash, machine: manifest.machine ?? machine() } });
  fs.writeFileSync(path.join(dir, "report.md"), md);
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(s, null, 2));
  if (flags.md) fs.writeFileSync(flags.md, md);
  io.out(flags.json ? JSON.stringify(s, null, 2) : renderTable(s));
  return 0;
}
