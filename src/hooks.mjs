// install-hook / uninstall-hook: merge or remove the Stop hook entry in a Claude
// Code settings.json without touching other hooks. Dry-run unless --write.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER_RE = /apex-context(?:\.mjs)?["']?\s+gate\b/;
const isOurs = (h) => h && typeof h === 'object' && typeof h.command === 'string' && MARKER_RE.test(h.command);

// Per agent: the hook event our gate listens on, the settings dir, and the gate's --agent value.
export const AGENTS = {
  claude: { event: 'Stop', projectDir: '.claude', userDir: (env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), flag: '' },
  gemini: { event: 'AfterAgent', projectDir: '.gemini', userDir: (env) => path.join(env.GEMINI_CLI_HOME || os.homedir(), '.gemini'), flag: ' --agent gemini' },
};
const agentOf = (a) => AGENTS[a === 'gemini' || a === 'gemini-cli' ? 'gemini' : 'claude'];

export function defaultCommand(agent = 'claude', { block = false } = {}) {
  const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'apex-context.mjs');
  return `node "${bin}" gate${agentOf(agent).flag}${block ? ' --block' : ''}`;
}

export function targetPath({ user = false, cwd = process.cwd(), env = process.env, agent = 'claude' } = {}) {
  const a = agentOf(agent);
  if (user) return path.join(a.userDir(env), 'settings.json');
  return path.join(cwd, a.projectDir, 'settings.json');
}

const tilde = (p) => { const h = os.homedir(); return p === h || p.startsWith(h + path.sep) ? '~' + p.slice(h.length) : p; };

/** Pure: returns { settings, changed }. Never mutates the input. */
export function addHook(settings, command, event = 'Stop') {
  const s = JSON.parse(JSON.stringify(settings || {}));
  if (typeof s !== 'object' || Array.isArray(s)) throw new Error('settings is not a JSON object');
  if (s.hooks == null) s.hooks = {};
  if (typeof s.hooks !== 'object' || Array.isArray(s.hooks)) throw new Error('"hooks" is not an object');
  if (s.hooks[event] == null) s.hooks[event] = [];
  if (!Array.isArray(s.hooks[event])) throw new Error(`"hooks.${event}" is not an array`);
  for (const g of s.hooks[event]) if (g && Array.isArray(g.hooks) && g.hooks.some(isOurs)) return { settings: s, changed: false };
  s.hooks[event].push({ hooks: [(event === 'AfterAgent' ? { name: 'apex-context-gate', type: 'command', command } : { type: 'command', command })] });
  return { settings: s, changed: true };
}

export function removeHook(settings, event = 'Stop') {
  const s = JSON.parse(JSON.stringify(settings || {}));
  let changed = false;
  if (s.hooks && Array.isArray(s.hooks[event])) {
    const keep = [];
    for (const g of s.hooks[event]) {
      if (g && Array.isArray(g.hooks) && g.hooks.some(isOurs)) {
        changed = true;
        const rest = g.hooks.filter((h) => !isOurs(h));
        if (rest.length) keep.push({ ...g, hooks: rest });
      } else keep.push(g);
    }
    if (changed) {
      if (keep.length) s.hooks[event] = keep; else delete s.hooks[event];
      if (!Object.keys(s.hooks).length) delete s.hooks;
    }
  }
  return { settings: s, changed };
}

/** Returns exit code. opts: {action:'install'|'uninstall', user, write, dryRun, settings, command} */
export function runHookCommand(opts, { cwd = process.cwd(), env = process.env, out, err }) {
  const ag = agentOf(opts.agent);
  const file = opts.settings ? path.resolve(opts.settings) : targetPath({ user: opts.user, cwd, env, agent: opts.agent });
  let current = {};
  if (fs.existsSync(file)) {
    try { current = JSON.parse(fs.readFileSync(file, 'utf8') || '{}'); } catch { err('Refusing to touch the settings file: it is not valid JSON.'); return 1; }
  }
  let r;
  try { r = opts.action === 'install' ? addHook(current, opts.command || defaultCommand(opts.agent, { block: opts.block }), ag.event) : removeHook(current, ag.event); }
  catch (e) { err('Refusing to touch the settings file: it has an unexpected shape.'); return 1; }
  const write = !!opts.write && !opts.dryRun;
  out(`${write ? 'Target' : 'Dry run. Target'}: ${tilde(file)}`);
  if (!r.changed) { out(opts.action === 'install' ? 'Already installed; nothing to change.' : 'Not installed; nothing to remove.'); return 0; }
  // Show only our entry, never the rest of the user's settings (which may hold env values or tokens).
  if (opts.action === 'install') out(JSON.stringify({ hooks: { [ag.event]: [r.settings.hooks[ag.event].at(-1)] } }, null, 2));
  else out(`Would remove the apex-context gate entry from hooks.${ag.event}.`);
  if (!write) { out('Nothing was changed. Add --write to apply.'); return 0; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.apex-tmp';
  let mode = 0o600; try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file */ }
  fs.writeFileSync(tmp, JSON.stringify(r.settings, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
  out(opts.action === 'install' ? 'Installed.' : 'Removed.');
  return 0;
}
