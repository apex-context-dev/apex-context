// Scoring: visible command first, then hidden tests are copied in and the hidden command runs.
// Pass = hidden exits 0 AND (no visible command OR visible exits 0). Commands are plain POSIX shell.
import { exec, overlay } from "./util.mjs";

export async function scoreWorkspace(ws, task, { env = process.env } = {}) {
  const timeoutMs = (task.meta.scoreTimeout ?? 120) * 1000;
  const e = { ...env, APEX_BENCH_SCORING: "1" };
  let visible = null;
  if (task.meta.visible) {
    const r = await exec(task.meta.visible, { cwd: ws, env: e, timeoutMs });
    visible = { ok: r.code === 0 && !r.timedOut, code: r.code, timedOut: r.timedOut, log: r.stdout + r.stderr };
  }
  overlay(task.hiddenDir, ws);
  const h = await exec(task.meta.hidden, { cwd: ws, env: e, timeoutMs });
  const hidden = { ok: h.code === 0 && !h.timedOut, code: h.code, timedOut: h.timedOut, log: h.stdout + h.stderr };
  return { visible, hidden, pass: hidden.ok && (visible ? visible.ok : true) };
}
