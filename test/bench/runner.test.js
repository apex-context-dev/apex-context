import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runBench, planCells } from "../../src/bench/runner.mjs";
import { builtinArms } from "../../src/bench/arms.mjs";
import { extractUsage, detectClaimedDone } from "../../src/bench/usage.mjs";
import { readJsonl } from "../../src/bench/util.mjs";
import { tmp, arm, armDefs, makeTask } from "./helpers.mjs";

const run = (o) => runBench({ runs: 1, concurrency: 1, log: () => {}, ...o });

test("fake arms: fix passes, noop fails, failing agent is recorded, liar is false-ready", async () => {
  const root = tmp(), out = tmp();
  makeTask(root, "t1");
  const done = { type: "regex", pattern: "^DONE" };
  const arms = [
    arm("fixer", "echo right > answer.txt; echo DONE", { claimedDone: done }),
    arm("noop", "true"),
    arm("crash", "echo boom >&2; exit 3", { claimedDone: done }),
    arm("liar", "echo DONE", { claimedDone: done }),
  ];
  const { rows } = await run({ tasksDir: root, armNames: arms.map((a) => a.name), armDefs: armDefs(...arms), outDir: out });
  const by = Object.fromEntries(rows.map((r) => [r.arm, r]));
  assert.equal(by.fixer.pass, true); assert.equal(by.fixer.falseReady, false); assert.equal(by.fixer.claimedDone, true);
  assert.equal(by.noop.pass, false); assert.equal(by.noop.claimedDone, null); assert.equal(by.noop.falseReady, null);
  assert.equal(by.crash.exitCode, 3); assert.equal(by.crash.pass, false); assert.equal(by.crash.falseReady, false);
  assert.equal(by.liar.falseReady, true);
  const dir = path.join(out, "runs", "t1__fixer__r1");
  for (const f of ["stdout.log", "stderr.log", "final.diff", "score-hidden.log", "row.json", "prompt.txt"]) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.match(fs.readFileSync(path.join(dir, "final.diff"), "utf8"), /\+right/);
  assert.match(fs.readFileSync(path.join(out, "runs", "t1__crash__r1", "stderr.log"), "utf8"), /boom/);
  assert.ok(fs.existsSync(path.join(out, "manifest.json")));
});

test("the hidden tests are not visible to the agent and the prompt arrives intact", async () => {
  const root = tmp(), out = tmp();
  makeTask(root, "t1");
  const a = arm("spy", `ls > "{outDir}/ls.txt"; printf '%s' {prompt} > "{outDir}/p.txt"; printf '%s' "$APEX_BENCH_PROMPT" > "{outDir}/penv.txt"`);
  await run({ tasksDir: root, armNames: ["spy"], armDefs: armDefs(a), outDir: out });
  const d = path.join(out, "runs", "t1__spy__r1", "agent-out");
  assert.doesNotMatch(fs.readFileSync(path.join(d, "ls.txt"), "utf8"), /check\.sh|hidden|reference/);
  assert.equal(fs.readFileSync(path.join(d, "p.txt"), "utf8"), `make answer.txt say right (it's "quoted")`);
  assert.equal(fs.readFileSync(path.join(d, "penv.txt"), "utf8"), fs.readFileSync(path.join(d, "p.txt"), "utf8"));
});

test("timeout kills the whole process group, still scores, marks timedOut", async () => {
  const root = tmp(), out = tmp();
  makeTask(root, "t1", { timeout: 1 });
  const marker = path.join(out, "survivor");
  const a = arm("hang", `echo right > answer.txt; (sleep 3; touch ${marker}) & sleep 30`);
  const t0 = Date.now();
  const { rows } = await run({ tasksDir: root, armNames: ["hang"], armDefs: armDefs(a), outDir: out });
  assert.ok(Date.now() - t0 < 10000);
  assert.equal(rows[0].timedOut, true); assert.match(rows[0].error, /timed out/);
  assert.equal(rows[0].pass, true); // edits made before the timeout are scored
  assert.ok(rows[0].seconds >= 1 && rows[0].seconds < 5);
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(fs.existsSync(marker), false, "background child must have been killed");
});

test("usage extraction: json file, json stdout, regex, none; claimedDone json", async () => {
  const r = { stdout: 'noise\n{"usage":{"input_tokens":10,"cache":5,"output_tokens":4}}\n', stderr: "tokens in=1,200 out=30\ntokens in=2,000 out=40", outDir: tmp() };
  fs.writeFileSync(path.join(r.outDir, "u.json"), '{"a":{"i":7,"o":3},"done":true,"status":"ok"}');
  assert.deepEqual(extractUsage({ type: "json", in: ["usage.input_tokens", "usage.cache"], out: "usage.output_tokens" }, r), { tokensIn: 15, tokensOut: 4 });
  assert.deepEqual(extractUsage({ type: "json", file: "{outDir}/u.json", in: "a.i", out: "a.o" }, r), { tokensIn: 7, tokensOut: 3 });
  assert.deepEqual(extractUsage({ type: "regex", source: "stderr", in: "in=([\\d,]+)", out: "out=(\\d+)" }, r), { tokensIn: 2000, tokensOut: 40 });
  assert.deepEqual(extractUsage({ type: "regex", source: "stderr", in: "in=([\\d,]+)", out: "out=(\\d+)", mode: "sum" }, r), { tokensIn: 3200, tokensOut: 70 });
  assert.deepEqual(extractUsage(null, r), { tokensIn: null, tokensOut: null });
  assert.deepEqual(extractUsage({ type: "json", file: "{outDir}/missing.json", in: "x" }, r), { tokensIn: null, tokensOut: null });
  assert.equal(detectClaimedDone({ type: "json", file: "{outDir}/u.json", field: "done" }, r), true);
  assert.equal(detectClaimedDone({ type: "json", file: "{outDir}/u.json", field: "status", equals: "ok" }, r), true);
  assert.equal(detectClaimedDone({ type: "json", file: "{outDir}/u.json", field: "nope" }, r), null);
  assert.equal(detectClaimedDone({ type: "json", file: "{outDir}/missing.json", field: "x" }, r), null);
  assert.equal(detectClaimedDone(undefined, r), null);
});

test("usage flows into rows end to end", async () => {
  const root = tmp(), out = tmp();
  makeTask(root, "t1");
  const a = arm("u", `echo right > answer.txt; echo '{"in":120,"out":30}' > "{outDir}/usage.json"`, { readUsage: { type: "json", file: "{outDir}/usage.json", in: "in", out: "out" } });
  const { rows } = await run({ tasksDir: root, armNames: ["u"], armDefs: armDefs(a), outDir: out });
  assert.equal(rows[0].tokensIn, 120); assert.equal(rows[0].tokensOut, 30);
});

test("visible command failing makes the run fail even if hidden passes", async () => {
  const root = tmp(), out = tmp();
  makeTask(root, "t1", { visible: "false" });
  const { rows } = await run({ tasksDir: root, armNames: ["f"], armDefs: armDefs(arm("f", "echo right > answer.txt")), outDir: out });
  assert.equal(rows[0].hiddenPass, true); assert.equal(rows[0].visiblePass, false); assert.equal(rows[0].pass, false);
});

test("resume skips finished cells; a rerun without --resume refuses; changed task reruns", async () => {
  const root = tmp(), out = tmp();
  makeTask(root, "t1"); makeTask(root, "t2");
  const defs = armDefs(arm("fixer", "echo right > answer.txt"), arm("noop", "true"));
  const o = { tasksDir: root, armNames: ["fixer", "noop"], armDefs: defs, outDir: out, runs: 2 };
  const first = await run(o);
  assert.equal(first.rows.length, 8);
  await assert.rejects(run(o), /--resume/);
  const again = await run({ ...o, resume: true });
  assert.equal(again.todo.length, 0); assert.equal(again.rows.length, 8);
  // simulate an interrupted run: drop the last 3 rows
  const f = path.join(out, "results.jsonl");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").split("\n").filter(Boolean).slice(0, 5).join("\n") + "\n");
  const part = await run({ ...o, resume: true });
  assert.equal(part.todo.length, 3); assert.equal(readJsonl(f).length, 8);
  // editing a task changes its hash, so its cells run again
  fs.appendFileSync(path.join(root, "t2", "project", "answer.txt"), "more\n");
  const changed = await run({ ...o, resume: true });
  assert.equal(changed.todo.length, 4);
});

test("dry run writes nothing and plans arm rotation", async () => {
  const root = tmp(), out = path.join(tmp(), "never");
  makeTask(root, "t1"); makeTask(root, "t2");
  const logs = [];
  const defs = armDefs(arm("a", "true"), arm("b", "true"));
  const r = await run({ tasksDir: root, armNames: ["a", "b"], armDefs: defs, outDir: out, dry: true, log: (m) => logs.push(m) });
  assert.equal(r.todo.length, 4); assert.equal(fs.existsSync(out), false);
  assert.ok(logs.some((l) => /4 to run/.test(l)));
  const first = (t) => r.cells.filter((c) => c.task.id === t)[0].arm.name;
  assert.notEqual(first("t1"), first("t2")); // first arm rotates between tasks
});

test("planCells covers every (task, arm, run) exactly once", () => {
  const tasks = ["a", "b", "c"].map((id) => ({ id })), arms = ["x", "y"].map((name) => ({ name }));
  const cells = planCells(tasks, arms, 3);
  assert.equal(cells.length, 18);
  assert.equal(new Set(cells.map((c) => `${c.task.id}${c.arm.name}${c.run}`)).size, 18);
});

test("unknown arm and unknown filter fail loudly", async () => {
  const root = tmp();
  makeTask(root, "t1");
  await assert.rejects(run({ tasksDir: root, armNames: ["nope"], armDefs: {}, outDir: tmp() }), /unknown arm/);
  await assert.rejects(run({ tasksDir: root, armNames: ["noop"], armDefs: builtinArms(), outDir: tmp(), filter: "zzz" }), /no tasks matched/);
});

test("demo: oracle solves every example task, noop solves none, liar is false-ready (CLI)", () => {
  const out = tmp();
  const r = spawnSync(process.execPath, ["bin/apex-context.mjs", "bench", "run", "examples/bench/tasks", "--arms", "oracle,noop,liar", "--runs", "1", "--out", out, "--json"], { encoding: "utf8", cwd: path.resolve(import.meta.dirname, "..", "..") });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.equal(s.arms.oracle.passes, 3); assert.equal(s.arms.noop.passes, 0); assert.equal(s.arms.liar.passes, 0);
  assert.equal(s.arms.liar.falseReady.rate, 1); assert.equal(s.arms.oracle.falseReady.rate, 0); assert.equal(s.arms.noop.falseReady, null);
  assert.ok(fs.existsSync(path.join(out, "report.md")));
});

test("fill quotes placeholders for bare, double-quoted and single-quoted contexts", async () => {
  const { fill } = await import("../../src/bench/runner.mjs");
  const v = { prompt: `it's "a" $HOME \`x\``, cwd: "/tmp/a b" };
  const run1 = (tpl) => spawnSync("sh", ["-c", `printf '%s' ${JSON.stringify("")}; ` + fill(tpl, v)], { encoding: "utf8" }).stdout;
  assert.equal(run1("printf '%s' {prompt}"), v.prompt);
  assert.equal(run1('printf \'%s\' "{prompt}"'), v.prompt);
  assert.equal(run1("printf '%s' '{prompt}'"), v.prompt);
  assert.equal(run1('printf \'%s\' "{cwd}/x"'), "/tmp/a b/x");
  assert.equal(fill("echo ${cwd}", v), "echo ${cwd}");
});

test("bench demo: runs the bundled examples with built-in arms from any cwd", async () => {
  const { main } = await import("../../src/bench/cli.mjs");
  const out = [];
  const code = await main(["demo"], { out: (t) => out.push(String(t)), err: () => {} });
  const text = out.join("\n");
  assert.equal(code, 0);
  assert.match(text, /3\/3 example tasks valid/);
  assert.match(text, /oracle/);
  assert.match(text, /liar/);
});
