import test from "node:test";
import assert from "node:assert/strict";
import { wilson, binomTwoSided, mcnemarExact, signTest, median, mean, bootstrapCI, pairedCompare, summarizeArm, summarize } from "../../src/bench/stats.mjs";

const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test("wilson known values", () => {
  let [l, h] = wilson(0, 10); close(l, 0); close(h, 0.2775);
  [l, h] = wilson(10, 10); close(l, 0.7225); close(h, 1);
  [l, h] = wilson(5, 10); close(l, 0.2366); close(h, 0.7634);
  assert.deepEqual(wilson(0, 0), [null, null]);
});

test("exact binomial / McNemar / sign test", () => {
  close(binomTwoSided(0, 10), 2 / 1024, 1e-9);
  close(mcnemarExact(6, 0), 0.03125, 1e-9);
  close(mcnemarExact(5, 0), 0.0625, 1e-9);
  close(mcnemarExact(5, 5), 1, 1e-9);
  close(mcnemarExact(1, 4), mcnemarExact(4, 1), 1e-12);
  close(mcnemarExact(0, 0), 1);
  close(signTest(8, 2), 0.109375, 1e-9); // 2 * (1+10+45)/1024
});

test("median, mean", () => { assert.equal(median([3, 1, 2]), 2); assert.equal(median([1, 2, 3, 4]), 2.5); assert.equal(mean([1, 2, 3]), 2); assert.equal(median([]), null); });

test("bootstrap is seeded, brackets the statistic, degenerates on constant data", () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const a = bootstrapCI(xs, mean, { seed: 7 }), b = bootstrapCI(xs, mean, { seed: 7 });
  assert.deepEqual(a, b);
  assert.ok(a[0] < 5.5 && a[1] > 5.5 && a[0] > 2.5 && a[1] < 8.5);
  assert.deepEqual(bootstrapCI([4, 4, 4], median), [4, 4]);
  assert.deepEqual(bootstrapCI([9], mean), [9, 9]);
});

const row = (taskId, arm, pass, extra = {}) => ({ taskId, taskHash: "h", arm, pass, seconds: 1, exitCode: 0, tokensIn: null, tokensOut: null, claimedDone: null, ...extra });

test("paired comparison counts discordant tasks by per-task majority", () => {
  const A = [], B = [];
  for (let i = 0; i < 8; i++) { A.push(row(`t${i}`, "a", true), row(`t${i}`, "a", true)); B.push(row(`t${i}`, "b", false), row(`t${i}`, "b", false)); }
  for (let i = 8; i < 10; i++) { A.push(row(`t${i}`, "a", true)); B.push(row(`t${i}`, "b", true)); }
  const p = pairedCompare(A, B);
  assert.equal(p.tasks, 10); assert.equal(p.onlyAPasses, 8); assert.equal(p.onlyBPasses, 0);
  close(p.pMcNemar, 2 / 256, 1e-9); assert.equal(p.verdict, "A better"); assert.equal(p.underpowered, false);
  close(p.meanPassRateDiff, 0.8);
});

test("paired: few discordant tasks is flagged underpowered, tie majority counts as fail", () => {
  const A = [row("x", "a", true), row("x", "a", false), row("y", "a", true)];
  const B = [row("x", "b", false), row("y", "b", false)];
  const p = pairedCompare(A, B);
  assert.equal(p.onlyAPasses, 1); // x tie (0.5) is not a majority pass; only y
  assert.equal(p.verdict, "no significant difference"); assert.equal(p.underpowered, true);
});

test("summarizeArm: tokens, false-ready, n/a handling", () => {
  const rows = [
    row("a", "z", true, { tokensIn: 100, tokensOut: 10, claimedDone: true, falseReady: false }),
    row("b", "z", false, { tokensIn: 300, tokensOut: 30, claimedDone: true, falseReady: true }),
    row("c", "z", false, { tokensIn: 200, tokensOut: 20, claimedDone: false, falseReady: false, timedOut: true }),
  ];
  const s = summarizeArm(rows);
  assert.equal(s.passes, 1); assert.equal(s.tokensTotal.median, 220); assert.equal(s.tokensTotal.n, 3);
  assert.equal(s.falseReady.claimedDone, 2); assert.equal(s.falseReady.falseReady, 1); assert.equal(s.falseReady.rate, 0.5);
  assert.equal(s.timeouts, 1);
  const none = summarizeArm([row("a", "z", true), row("b", "z", false)]);
  assert.equal(none.tokensTotal, null); assert.equal(none.falseReady, null);
});

test("summarize picks noop as baseline and warns on mixed task versions", () => {
  const rows = [row("t", "noop", false), row("t", "x", true), { ...row("t", "x", true), taskHash: "other" }];
  const s = summarize(rows);
  assert.equal(s.baseline, "noop");
  assert.ok(s.warnings.some((w) => /more than one version/.test(w)));
});
