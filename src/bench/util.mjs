// Small shared helpers: hashing, copying, shell execution with a hard timeout. No dependencies.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

export const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
const IGNORE = new Set([".DS_Store", "node_modules", "__pycache__", ".pytest_cache", ".git"]);

/** Relative paths of every file under dir (sorted, POSIX separators). */
export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      if (IGNORE.has(name)) continue;
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p); else out.push(path.relative(dir, p).split(path.sep).join("/"));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** sha256 over relative paths + bytes of every file in a folder, 12 hex chars. */
export function hashDir(dir) {
  const h = crypto.createHash("sha256");
  for (const rel of listFiles(dir)) { h.update(rel + "\0"); h.update(fs.readFileSync(path.join(dir, rel))); h.update("\0"); }
  return h.digest("hex").slice(0, 12);
}

export const hashSet = (tasks) => sha(tasks.map((t) => `${t.id}:${t.hash}`).join("\n"));

/** Stable JSON (sorted keys) so config hashes do not depend on key order. */
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

const skipJunk = (src) => path.basename(src) !== ".DS_Store";
export function copyDir(src, dst) { fs.mkdirSync(dst, { recursive: true }); fs.cpSync(src, dst, { recursive: true, filter: skipJunk }); }
/** Copy src over dst (files replaced, others kept). */
export function overlay(src, dst) { if (fs.existsSync(src)) copyDir(src, dst); }

export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Process groups of live children, so Ctrl-C can clean them up. */
export const liveGroups = new Set();

/**
 * Runs a shell command (POSIX sh) in its own process group; on timeout the whole group is SIGKILLed.
 * Never rejects. `suspended` is true when wall-clock time ran noticeably ahead of the monotonic clock
 * (the machine slept during the run), which makes the timing untrustworthy.
 */
export function exec(cmd, { cwd, env = process.env, timeoutMs = 0, maxBytes = 4_000_000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now(), h0 = process.hrtime.bigint();
    let stdout = "", stderr = "", timedOut = false, error = null;
    // A parent `node --test` would make a nested `node --test` swallow failures; the agent and scoring must see a clean env.
    const cleanEnv = { ...env }; delete cleanEnv.NODE_TEST_CONTEXT;
    const child = spawn(cmd, { cwd, env: cleanEnv, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const group = child.pid;
    if (group) liveGroups.add(group);
    const kill = () => { try { process.kill(-group, "SIGKILL"); } catch { /* already gone */ } };
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; kill(); }, timeoutMs) : null;
    child.stdout.on("data", (d) => { if (stdout.length < maxBytes) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < maxBytes) stderr += d; });
    child.on("error", (e) => { error = e.message; });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      kill(); // stragglers
      if (group) liveGroups.delete(group);
      const wallMs = Date.now() - t0, monoMs = Number(process.hrtime.bigint() - h0) / 1e6;
      resolve({ code: code ?? (signal ? 128 : 1), signal, stdout, stderr, timedOut, error, ms: wallMs, suspended: wallMs - monoMs > 3000 });
    });
  });
}

export function onBattery() {
  if (process.platform !== "darwin") return false;
  try { return /Battery Power/.test(spawnSync("pmset", ["-g", "batt"], { encoding: "utf8", timeout: 5000 }).stdout || ""); } catch { return false; }
}

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
