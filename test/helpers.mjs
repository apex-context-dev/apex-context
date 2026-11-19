// Synthetic transcript builders (Claude Code shape). No real data anywhere.
let n = 0;
const iso = (t) => new Date(t).toISOString();
export const T0 = Date.parse('2026-11-01T10:00:00Z');
export class Fx {
  constructor(sessionId = 's1') { this.sid = sessionId; this.lines = []; this.t = T0; }
  tick() { this.t += 1000; return iso(this.t); }
  raw(o) { this.lines.push(JSON.stringify(o)); return this; }
  prompt(text = 'do the thing') {
    return this.raw({ type: 'user', sessionId: this.sid, timestamp: this.tick(), message: { role: 'user', content: text } });
  }
  assistant(blocks, { usage, model = 'claude-sonnet-5-5', id } = {}) {
    id = id || 'msg_' + ++n;
    const u = usage || { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 20 };
    for (const b of blocks) {
      this.raw({ type: 'assistant', sessionId: this.sid, timestamp: this.tick(), message: { id, model, role: 'assistant', content: [b], usage: u } });
    }
    return this;
  }
  text(t, o) { return this.assistant([{ type: 'text', text: t }], o); }
  tool(name, input, result = { content: 'ok' }, o) {
    const id = 'tu_' + ++n;
    this.assistant([{ type: 'tool_use', id, name, input }], o);
    const body = { tool_use_id: id, type: 'tool_result', content: result.content };
    if (result.is_error) body.is_error = true;
    return this.raw({ type: 'user', sessionId: this.sid, timestamp: this.tick(), message: { role: 'user', content: [body] } });
  }
  read(file, chars = 20000, lines = 400) { return this.tool('Read', { file_path: file }, { content: ('x'.repeat(49) + '\n').repeat(Math.ceil(chars / 50)) }).__lines(lines); }
  __lines() { return this; }
  edit(file, old = 'a\nb', nw = 'c') { return this.tool('Edit', { file_path: file, old_string: old, new_string: nw }); }
  bash(command, content = 'ok', is_error = false) { return this.tool('Bash', { command }, { content, is_error }); }
  toString() { return this.lines.join('\n') + '\n'; }
}
