// Find and read transcript files (read-only), parse via an adapter, apply --since.

import fs from 'node:fs';
import path from 'node:path';

/** "30d", "12h", "2w" -> milliseconds; null if invalid. */
export function parseSince(s) {
  const m = /^(\d+(?:\.\d+)?)\s*([hdw])$/i.exec(String(s || '').trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n * { h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2].toLowerCase()];
}

/** Recursively list *.jsonl under dir. Never follows into errors. */
export function findJsonl(dir, match = (n) => n.endsWith('.jsonl')) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && match(e.name, p)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * @param {{dirs:string[], sinceMs:number, now?:number, adapter:any}} o
 */
export function loadSessions({ dirs, sinceMs, now = Date.now(), adapter }) {
  const cutoff = now - sinceMs;
  const sessions = [];
  const info = { dirsChecked: [], filesFound: 0, filesInWindow: 0, filesUnreadable: 0, lines: 0, understood: 0, malformed: 0, skipped: 0, cutoff };
  for (const dir of dirs) {
    const exists = fs.existsSync(dir);
    info.dirsChecked.push({ exists });
    if (!exists) continue;
    for (const file of findJsonl(dir, adapter.matchFile)) {
      info.filesFound++;
      let st, text;
      try { st = fs.statSync(file); } catch { info.filesUnreadable++; continue; }
      if (st.mtimeMs < cutoff) continue;
      try { text = fs.readFileSync(file, 'utf8'); } catch { info.filesUnreadable++; continue; }
      const rel = path.relative(dir, file).split(path.sep);
      const s = adapter.parseSession(text, { file, isSubagentFile: rel.includes('subagents') });
      // keep only turns inside the window (by message timestamp when known)
      s.turns = s.turns.filter((t) => t.ts == null || t.ts >= cutoff);
      if (s.lastTs != null && s.lastTs < cutoff) continue;
      info.filesInWindow++;
      info.lines += s.stats.lines; info.understood += s.stats.understood;
      info.malformed += s.stats.malformed; info.skipped += s.stats.skipped;
      sessions.push(s);
    }
  }
  return { sessions, info };
}
