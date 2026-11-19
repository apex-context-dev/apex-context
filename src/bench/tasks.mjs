// Task and arm loading and validation of their JSON shape. See docs/TASK-FORMAT.md.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hashDir, sha, stableStringify } from "./util.mjs";

export function loadTask(dir) {
  const file = path.join(dir, "task.json");
  let j;
  try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error(`${dir}: cannot read task.json (${e.message})`); }
  const problems = checkTask(j);
  if (problems.length) throw new Error(`${dir}: ${problems.join("; ")}`);
  return {
    id: j.id, kind: j.kind, prompt: j.prompt, timeout: j.timeout, steps: j.steps ?? null, meta: j.meta, title: j.title ?? j.id,
    dir, projectDir: path.join(dir, "project"), hiddenDir: path.join(dir, "hidden"), referenceDir: path.join(dir, "reference"),
    hash: hashDir(dir),
  };
}

export function checkTask(j) {
  const p = [];
  if (!j || typeof j !== "object") return ["task.json is not an object"];
  if (typeof j.id !== "string" || !/^[\w.-]+$/.test(j.id)) p.push("id must match [A-Za-z0-9_.-]+");
  if (typeof j.kind !== "string" || !j.kind) p.push("kind is required");
  if (typeof j.prompt !== "string" || !j.prompt.trim()) p.push("prompt is required");
  if (!(typeof j.timeout === "number" && j.timeout > 0)) p.push("timeout (seconds, > 0) is required");
  if (j.steps != null && !(Number.isInteger(j.steps) && j.steps > 0)) p.push("steps must be a positive integer");
  if (!j.meta || typeof j.meta.hidden !== "string" || !j.meta.hidden.trim()) p.push("meta.hidden (shell command) is required");
  if (j.meta?.visible != null && typeof j.meta.visible !== "string") p.push("meta.visible must be a string");
  return p;
}

/** All subfolders of root that contain task.json, optionally filtered by id substring(s). */
export function loadTasks(root, filter = "") {
  if (!fs.existsSync(root)) throw new Error(`tasks folder not found: ${root}`);
  const filters = String(filter || "").split(",").map((s) => s.trim()).filter(Boolean);
  const tasks = fs.readdirSync(root).sort()
    .map((n) => path.join(root, n))
    .filter((d) => fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, "task.json")))
    .map(loadTask)
    .filter((t) => !filters.length || filters.some((f) => t.id.includes(f)));
  const ids = new Set();
  for (const t of tasks) { if (ids.has(t.id)) throw new Error(`duplicate task id ${t.id}`); ids.add(t.id); }
  return tasks;
}

export function normalizeArm(a, nameHint) {
  const arm = { name: a.name ?? nameHint, command: a.command, env: a.env ?? {}, readUsage: a.readUsage ?? null, claimedDone: a.claimedDone ?? null, description: a.description ?? "" };
  if (typeof arm.name !== "string" || !/^[\w.-]+$/.test(arm.name)) throw new Error(`arm name must match [A-Za-z0-9_.-]+ (got ${JSON.stringify(arm.name)})`);
  if (typeof arm.command !== "string" || !arm.command.trim()) throw new Error(`arm ${arm.name}: command is required`);
  arm.hash = sha(stableStringify({ command: arm.command, env: arm.env, readUsage: arm.readUsage, claimedDone: arm.claimedDone }));
  return arm;
}

/** Arms from a .json or .mjs file: an object {name: cfg}, an array of {name, ...}, or (mjs) a default export of either. */
export async function loadArmsFile(file) {
  let raw;
  if (file.endsWith(".json")) raw = JSON.parse(fs.readFileSync(file, "utf8"));
  else raw = (await import(pathToFileURL(path.resolve(file)).href)).default;
  const list = Array.isArray(raw) ? raw.map((a) => normalizeArm(a)) : Object.entries(raw).map(([n, a]) => normalizeArm(a, n));
  return Object.fromEntries(list.map((a) => [a.name, a]));
}

/** Manifest-safe view of an arm: env values are never written, only the names. */
export const redactArm = (a) => ({ name: a.name, hash: a.hash, command: a.command, envKeys: Object.keys(a.env), readUsage: a.readUsage, claimedDone: a.claimedDone });
