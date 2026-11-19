import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeArm } from "../../src/bench/tasks.mjs";

export const tmp = (p = "ab-test-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
export const arm = (name, command, extra = {}) => normalizeArm({ name, command, ...extra });
export const armDefs = (...arms) => Object.fromEntries(arms.map((a) => [a.name, a]));

/** A shell-only task: the agent must make answer.txt contain "right". Scoring greps for it. */
export function makeTask(root, id, { timeout = 20, hiddenCmd = "sh check.sh", visible = null, projectAnswer = "wrong", checkScript = 'grep -q right answer.txt' } = {}) {
  const d = path.join(root, id);
  for (const s of ["project", "hidden", "reference"]) fs.mkdirSync(path.join(d, s), { recursive: true });
  fs.writeFileSync(path.join(d, "task.json"), JSON.stringify({ id, kind: "fix", prompt: `make answer.txt say right (it's "quoted")`, timeout, meta: { hidden: hiddenCmd, ...(visible ? { visible } : {}) } }));
  fs.writeFileSync(path.join(d, "project", "answer.txt"), projectAnswer + "\n");
  fs.writeFileSync(path.join(d, "hidden", "check.sh"), checkScript + "\n");
  fs.writeFileSync(path.join(d, "reference", "answer.txt"), "right\n");
  return d;
}
