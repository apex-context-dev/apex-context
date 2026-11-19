import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validateTask, validateAll } from "../../src/bench/validate.mjs";
import { tmp, makeTask } from "./helpers.mjs";

test("a sane task validates", async () => {
  const d = makeTask(tmp(), "ok");
  const r = await validateTask(d);
  assert.equal(r.ok, true, r.problems.join("; "));
});

test("project that already passes hidden tests is rejected", async () => {
  const r = await validateTask(makeTask(tmp(), "t", { projectAnswer: "right" }));
  assert.equal(r.ok, false); assert.match(r.problems.join(), /PASS on project/);
});

test("reference that does not pass is rejected", async () => {
  const d = makeTask(tmp(), "t");
  fs.writeFileSync(path.join(d, "reference", "answer.txt"), "still wrong\n");
  const r = await validateTask(d);
  assert.match(r.problems.join(), /FAIL with reference/);
});

test("hidden file present in project/ is rejected", async () => {
  const d = makeTask(tmp(), "t");
  fs.copyFileSync(path.join(d, "hidden", "check.sh"), path.join(d, "project", "check.sh"));
  assert.match((await validateTask(d)).problems.join(), /also exists in project/);
});

test("non-deterministic scoring is rejected", async () => {
  const ctr = path.join(tmp(), "ctr");
  const d = makeTask(tmp(), "t", { hiddenCmd: `sh -c 'f=${ctr}; n=$(cat $f 2>/dev/null || echo 0); echo $((n+1)) > $f; [ $((n % 2)) -eq 1 ]'` });
  const r = await validateTask(d);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /non-deterministic|PASS on project|FAIL with reference/);
});

test("bad task.json and missing reference are reported", async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "bad"));
  fs.writeFileSync(path.join(root, "bad", "task.json"), JSON.stringify({ id: "bad" }));
  assert.match((await validateTask(path.join(root, "bad"))).problems[0], /kind is required/);
  const d = makeTask(root, "noref");
  fs.rmSync(path.join(d, "reference"), { recursive: true });
  assert.match((await validateTask(d)).problems.join(), /reference\/ is missing/);
});

test("validateAll accepts a folder of tasks and the shipped examples", async () => {
  const res = await validateAll(path.resolve(import.meta.dirname, "..", "..", "examples", "bench", "tasks"));
  assert.equal(res.length, 3);
  assert.ok(res.every((r) => r.ok), JSON.stringify(res.filter((r) => !r.ok)));
});
