# Adapters

An adapter is one ES module in `src/adapters/` that knows one agent's on-disk session format. Everything else (metrics, gate, rendering) sees only the normalized model below, so adding an agent means adding one file.

## Interface

```js
export const name = 'my-agent';                 // shown in messages
export const tailable = true;                   // true: append-only JSONL, may be read from the end; false: one whole document
export const matchFile = (fileName, fullPath) => boolean;   // which files are sessions
export function defaultDirs() { return [ '/abs/path/to/logs' ]; }
export function parseSession(text, { file, isSubagentFile }) -> Session
export const detectPayload = (payload) => boolean;  // gate only: is this hook payload from your agent?
```

`parseSession` must never throw on bad input: count malformed lines in `stats.malformed` and carry on.

## Normalized session model

```
Session { id, file, isSubagentFile, turns[], firstTs, lastTs, cwd?, stats:{ lines, understood, malformed, skipped } }
Turn    { role:'user'|'assistant', ts, sidechain, isPrompt, model, msgId, usage, textTail, textHead?, toolCalls[] }
Usage   { input, cacheRead, cacheCreate, output }
ToolCall{ id, name, kind:'read'|'edit'|'write'|'bash'|'search'|'other', file, whole?, oldLines?, newLines?, command?, result }
Result  { isError, exitCode, chars, lines, tail }
```

Rules that keep the privacy guarantees:

- Message text is kept only as a short head/tail for pattern matching, in memory. Never return, print or store it.
- Never print `file`, `cwd`, `command` or `tail`; the only strings that reach output are fixed vocabulary, counts and model ids (which `metrics.safeModel` filters).
- Open files read-only. Do not touch the agent's folders.
- No network. No child processes outside `src/bench/` (a test fails the build if report/gate code imports them).

## Wiring it in

1. Add `src/adapters/my-agent.mjs`.
2. Register it in `src/cli.mjs` (the `--agent` choice and the `adapter` selection) and in `ADAPTERS` in `src/gate.mjs`.
3. If the agent has hooks, add an entry to `AGENTS` in `src/hooks.mjs` (event name, settings location).
4. Add `test/my-agent.test.mjs` with a synthetic fixture and add its sentinel strings to `test/privacy.test.mjs`.
