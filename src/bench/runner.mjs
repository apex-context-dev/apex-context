// The run loop: plan cells, run each arm on a fresh copy of the project, score, append a JSONL row, save artifacts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadTasks, redactArm } from "./tasks.mjs";
import { extractUsage, detectClaimedDone } from "./usage.mjs";
import { scoreWorkspace } from "./scoring.mjs";
import { BENCH_SRC } from "./arms.mjs";
import { copyDir, exec, hashSet, liveGroups, onBattery, readJsonl, shq } from "./util.mjs";

export const HARNESS_VERSION = "apex-bench-1";

export const cellKey = (c) => `${c.taskHash}|${c.armHash}|${c.run}|${c.seed ?? ""}|${c.temperature ?? ""}`;

export function machine() {
  return { os: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version, cpu: os.cpus()[0]?.model ?? "unknown", cores: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30) };
}

/**
 * Cells ordered run-major, then task, with the arm order rotated per (task, run), so no arm is always first
 * (cache warmth, thermal state and time-of-day drift are spread across arms instead of favouring one).
 */
export function planCells(tasks, arms, runs) {
  const cells = [];
  for (let run = 1; run <= runs; run++) {
    tasks.forEach((task, ti) => {
      for (let k = 0; k < arms.length; k++) cells.push({ task, arm: arms[(k + ti + run - 1) % arms.length], run });
    });
  }
  return cells;
}

const NAMES = "prompt|cwd|promptFile|outDir|taskDir|taskId|steps|seed|temperature|timeout|benchSrc";
const PLACEHOLDER = new RegExp(`^\\{(${NAMES})\\}`);

/**
 * Substitutes {prompt} {cwd} ... into a shell command, quoting for whatever quote context the placeholder sits in
 * (bare, "double" or 'single'), so `--cwd {cwd}`, `--cwd "{cwd}"` and `"{outDir}/x.json"` are all safe.
 * `${name}` (a shell expansion) is left alone.
 */
export function fill(tpl, vars) {
  let out = "", q = "";
  for (let i = 0; i < tpl.length; i++) {
    const ch = tpl[i];
    if (ch === "\\" && q !== "'") { out += ch + (tpl[i + 1] ?? ""); i++; continue; }
    if (ch === "'" && q !== '"') { q = q === "'" ? "" : "'"; out += ch; continue; }
    if (ch === '"' && q !== "'") { q = q === '"' ? "" : '"'; out += ch; continue; }
    if (ch === "{" && tpl[i - 1] !== "$") {
      const m = tpl.slice(i).match(PLACEHOLDER);
      if (m) {
        const v = String(vars[m[1]] ?? "");
        out += q === "" ? shq(v) : q === '"' ? v.replace(/[\\"$`]/g, "\\$&") : v.replaceAll("'", `'\\''`);
        i += m[0].length - 1; continue;
      }
    }
    out += ch;
  }
  return out;
}

function diffOf(a, b) {
  const r = spawnSync("diff", ["-ruN", "-x", "node_modules", "-x", ".DS_Store", "-x", ".git", a, b], { encoding: "utf8", maxBuffer: 64 * 2 ** 20 });
  if (r.error || r.status === 2) return { text: `(diff unavailable: ${r.error?.message ?? r.stderr})\n`, lines: null };
  const text = r.stdout.replaceAll(a, "a").replaceAll(b, "b");
  return { text, lines: text.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length };
}

export async function runCell(cell, { outDir, seed, temperature, timeoutOverride, keep }) {
  const { task, arm, run } = cell;
  const runId = `${task.id}__${arm.name}__r${run}`;
  const runDir = path.join(outDir, "runs", runId);
  fs.rmSync(runDir, { recursive: true, force: true });
  const agentOut = path.join(runDir, "agent-out");
  fs.mkdirSync(agentOut, { recursive: true });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-context-bench-ws-"));
  copyDir(task.projectDir, ws);
  const promptFile = path.join(runDir, "prompt.txt");
  fs.writeFileSync(promptFile, task.prompt);
  const timeout = timeoutOverride ?? task.timeout;
  const vars = { prompt: task.prompt, cwd: ws, promptFile, outDir: agentOut, taskDir: task.dir, taskId: task.id, steps: task.steps ?? "", seed: seed ?? "", temperature: temperature ?? "", timeout, benchSrc: BENCH_SRC };
  const env = {
    ...process.env, ...arm.env,
    APEX_BENCH_PROMPT: task.prompt, APEX_BENCH_PROMPT_FILE: promptFile, APEX_BENCH_CWD: ws, APEX_BENCH_OUT: agentOut,
    APEX_BENCH_TASK: task.id, APEX_BENCH_STEPS: String(task.steps ?? ""), APEX_BENCH_SEED: String(seed ?? ""), APEX_BENCH_TEMPERATURE: String(temperature ?? ""), APEX_BENCH_TIMEOUT: String(timeout),
  };
  const startedAt = new Date().toISOString();
  const r = await exec(fill(arm.command, vars), { cwd: ws, env, timeoutMs: timeout * 1000 });
  fs.writeFileSync(path.join(runDir, "stdout.log"), r.stdout);
  fs.writeFileSync(path.join(runDir, "stderr.log"), r.stderr);
  const d = diffOf(task.projectDir, ws);
  fs.writeFileSync(path.join(runDir, "final.diff"), d.text);

  const io = { stdout: r.stdout, stderr: r.stderr, outDir: agentOut };
  let usage = { tokensIn: null, tokensOut: null }, claimedDone = null, error = r.error;
  try { usage = extractUsage(arm.readUsage, io); claimedDone = detectClaimedDone(arm.claimedDone, io); } catch (e) { error = error ?? e.message; }
  const score = await scoreWorkspace(ws, task);
  fs.writeFileSync(path.join(runDir, "score-visible.log"), score.visible?.log ?? "(no visible command)\n");
  fs.writeFileSync(path.join(runDir, "score-hidden.log"), score.hidden.log);
  if (!keep) fs.rmSync(ws, { recursive: true, force: true });
  if (r.timedOut) error = error ?? `timed out after ${timeout}s`;

  const row = {
    schema: 1, harness: HARNESS_VERSION, taskId: task.id, taskHash: task.hash, kind: task.kind, arm: arm.name, armHash: arm.hash, run,
    seed: seed ?? null, temperature: temperature ?? null, pass: score.pass, hiddenPass: score.hidden.ok, visiblePass: score.visible ? score.visible.ok : null,
    seconds: Math.round(r.ms) / 1000, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, claimedDone,
    falseReady: claimedDone === null ? null : claimedDone && !score.pass,
    exitCode: r.code, timedOut: r.timedOut, suspended: r.suspended, diffLines: d.lines, error: error ?? null, runId, startedAt,
    node: process.version, os: `${os.platform()} ${os.arch()}`, wsKept: keep ? ws : null,
  };
  fs.writeFileSync(path.join(runDir, "row.json"), JSON.stringify(row, null, 2));
  return row;
}

/**
 * o: {tasksDir, armNames, armDefs, runs, filter, outDir, resume, dry, concurrency, seed, temperature, timeoutOverride, keep, log}
 * Returns {cells, todo, rows (all rows in results.jsonl after the run)}.
 */
export async function runBench(o) {
  const log = o.log ?? (() => {});
  const runs = o.runs ?? 1, concurrency = Math.max(1, o.concurrency ?? 1);
  const tasks = loadTasks(o.tasksDir, o.filter);
  if (!tasks.length) throw new Error("no tasks matched");
  const arms = o.armNames.map((n) => { if (!o.armDefs[n]) throw new Error(`unknown arm "${n}" (known: ${Object.keys(o.armDefs).join(", ")})`); return o.armDefs[n]; });
  const setHash = hashSet(tasks);
  const cells = planCells(tasks, arms, runs).map((c) => ({ ...c, taskHash: c.task.hash, armHash: c.arm.hash, seed: o.seed, temperature: o.temperature }));
  const results = path.join(o.outDir, "results.jsonl");
  const existing = readJsonl(results);
  if (existing.length && !o.resume && !o.dry) throw new Error(`${results} already has ${existing.length} rows; pass --resume to continue it or --fresh to start over`);
  const done = new Set(existing.map((r) => cellKey(r)));
  const todo = cells.filter((c) => !done.has(cellKey(c)));

  log(`tasks ${tasks.length} (set ${setHash}), arms ${arms.map((a) => a.name).join(",")}, runs ${runs}: ${cells.length} cells, ${cells.length - todo.length} already done, ${todo.length} to run`);
  if (o.dry) {
    for (const c of todo) log(`  ${c.task.id}  ${c.arm.name}  run ${c.run}  timeout ${o.timeoutOverride ?? c.task.timeout}s`);
    log(`worst case ${Math.round(todo.reduce((s, c) => s + (o.timeoutOverride ?? c.task.timeout), 0))}s if every run hit its timeout`);
    return { cells, todo, rows: existing };
  }
  if (onBattery()) log("WARNING: running on battery power; CPU throttling can distort timings. Plug in for a fair benchmark.");
  if (concurrency > 1) log(`WARNING: concurrency ${concurrency}: runs share the machine, so seconds are not comparable with a sequential run.`);

  fs.mkdirSync(o.outDir, { recursive: true });
  const manifest = {
    harness: HARNESS_VERSION, startedAt: new Date().toISOString(), setHash, machine: machine(), runs, seed: o.seed ?? null, temperature: o.temperature ?? null, concurrency,
    tasks: tasks.map((t) => ({ id: t.id, hash: t.hash })), arms: Object.fromEntries(arms.map((a) => [a.name, redactArm(a)])),
  };
  fs.writeFileSync(path.join(o.outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const onSigint = () => { for (const g of liveGroups) { try { process.kill(-g, "SIGKILL"); } catch { /* gone */ } } log("\ninterrupted; finished rows are kept, rerun with --resume"); process.exit(130); };
  process.once("SIGINT", onSigint);
  let next = 0, n = 0;
  const worker = async () => {
    while (next < todo.length) {
      const c = todo[next++];
      const row = await runCell(c, o);
      fs.appendFileSync(results, JSON.stringify(row) + "\n");
      log(`[${++n}/${todo.length}] ${row.taskId} ${row.arm} r${row.run}: ${row.pass ? "PASS" : "fail"} ${row.seconds}s${row.timedOut ? " TIMEOUT" : ""}${row.suspended ? " SUSPENDED(timing unreliable)" : ""}${row.falseReady ? " FALSE-READY" : ""}`);
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(concurrency, todo.length || 1) }, worker)); }
  finally { process.removeListener("SIGINT", onSigint); }
  return { cells, todo, rows: readJsonl(results) };
}
