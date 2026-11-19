// `apex-context bench validate`: is a task sane? Returns {ok, problems[], notes[]}.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadTask } from "./tasks.mjs";
import { scoreWorkspace } from "./scoring.mjs";
import { copyDir, listFiles, overlay } from "./util.mjs";

async function scoreOn(task, withReference) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-context-bench-validate-"));
  try {
    copyDir(task.projectDir, ws);
    if (withReference) overlay(task.referenceDir, ws);
    return await scoreWorkspace(ws, task);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
}

export async function validateTask(dir) {
  const problems = [], notes = [];
  let task;
  try { task = loadTask(dir); } catch (e) { return { ok: false, problems: [e.message], notes }; }
  if (!fs.existsSync(task.projectDir)) problems.push("project/ is missing");
  const hiddenFiles = listFiles(task.hiddenDir);
  if (!hiddenFiles.length) problems.push("hidden/ is missing or empty");
  const refFiles = listFiles(task.referenceDir);
  if (!refFiles.length) problems.push("reference/ is missing or empty");
  const projectFiles = new Set(listFiles(task.projectDir));
  for (const f of hiddenFiles) if (projectFiles.has(f)) problems.push(`hidden file ${f} also exists in project/ (the agent could see it, or scoring would overwrite a visible file)`);
  for (const f of listFiles(task.projectDir)) if (/(^|\/)(hidden|reference)(\/|$)/.test(f)) problems.push(`project/${f} looks like a leak of hidden/ or reference/`);
  if (problems.length) return { ok: false, problems, notes };

  const given = [await scoreOn(task, false), await scoreOn(task, false)];
  const solved = [await scoreOn(task, true), await scoreOn(task, true)];
  const same = (a, b) => a.hidden.ok === b.hidden.ok && (a.visible?.ok ?? null) === (b.visible?.ok ?? null);
  if (given.some((s) => s.hidden.ok)) problems.push("hidden tests PASS on project/ as given (the task is already solved or the tests are too weak)");
  if (solved.some((s) => !s.hidden.ok)) problems.push(`hidden tests FAIL with reference/ applied (exit ${solved[0].hidden.code}): ${solved[0].hidden.log.trim().split("\n").slice(-3).join(" | ")}`);
  if (solved.some((s) => s.visible && !s.visible.ok)) problems.push(`visible tests FAIL with reference/ applied (exit ${solved[0].visible.code})`);
  if (!same(given[0], given[1])) problems.push("non-deterministic: scoring project/ twice gave different results");
  if (!same(solved[0], solved[1])) problems.push("non-deterministic: scoring project/+reference/ twice gave different results");
  if (task.meta.visible && given[0].visible && !given[0].visible.ok) notes.push("visible tests already fail on project/ (fine for fix tasks, odd otherwise)");
  if (!task.meta.visible) notes.push("no visible command: the agent has no tests of its own to run");
  return { ok: problems.length === 0, problems, notes, id: task.id, hash: task.hash };
}

export async function validateAll(root) {
  const dirs = fs.existsSync(path.join(root, "task.json")) ? [root]
    : fs.readdirSync(root).sort().map((n) => path.join(root, n)).filter((d) => fs.existsSync(path.join(d, "task.json")));
  if (!dirs.length) throw new Error(`no task.json found in ${root} or its subfolders`);
  const out = [];
  for (const d of dirs) out.push({ dir: d, ...(await validateTask(d)) });
  return out;
}
