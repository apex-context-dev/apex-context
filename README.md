# apex-context

Your coding agent shouldn't be able to say "done" without proof. apex-context reads your local agent logs, shows how often it did, and can warn (or block) when code was edited and nothing checked it.

Local, read-only, no network, zero dependencies, Node >= 20, Apache-2.0.

## 60-second quickstart

```sh
npx apex-context report                     # last 30 days of Claude Code logs; nothing to configure
npx apex-context install-hook               # dry run: prints the hook entry and the file it would go in
npx apex-context install-hook --write       # apply it (./.claude/settings.json; --user for ~/.claude)
```

Nothing is written unless you pass `--write`. Remove it with `uninstall-hook --write`. Pause it with `APEX_CONTEXT_GATE=off`.

## Commands

`apex-context --help` lists them; `apex-context <command> --help` shows options.

**report** prints what your own logs say. Example output (synthetic numbers):

```
apex-context: last 30d

42 sessions (2026-10-20 to 2026-11-18), 310M tokens (about $190.00, estimate).
  input 1.2M, cache read 290M, cache write 11M, output 3.1M

Spends less?
About 4.2M tokens (~$9.40, estimate) were large file reads the agent used little of (6.1% of input-side tokens).
  Conservative; not a promise of savings.

Can't fake done?
23 of 61 completion claims (38%) had nothing run after the last edit to check them.
  29 proven by a passing test/typecheck/build, 7 manually checked, 2 where the last test failed.

Read-only and local: nothing left this machine. ...
```

Flags: `--agent claude|gemini`, `--since 30d` (`12h`, `2w`), `--dir <path>`, `--prices <file>`, `--json` (aggregates only), `--share` (short card), `--explain` (every formula).

**gate** is a hook. After each agent turn it checks: was source code edited, and did a test/typecheck/lint/build run after the last edit? If not it prints a one-line warning (default) or, with `--block`, asks the agent to run the checks first. It never loops (at most 2 blocks per turn by default) and fails open on any error. `gate --explain` prints the exact rules.

**install-hook / uninstall-hook** add or remove that hook in a `settings.json`. Dry run by default, merge-safe, idempotent, refuses invalid JSON.

## Supported agents and what is verified

| Agent | report | gate |
|---|---|---|
| Claude Code | tested on synthetic fixtures and run on real local logs | Stop hook: **not yet verified against a live session**. The allow path is covered by tests only; the hook contract is assumed from documentation. |
| Gemini CLI | tested on synthetic fixtures | AfterAgent hook: **block path verified live on Gemini CLI 0.32.1**. Allow path covered by tests only. |

Gemini note: headless `-p` with auto-edit approval does not offer the shell tool, so an agent cannot run tests there; a blocking gate can only be satisfied in interactive mode, with `--yolo`, or with an allow-list.

## Privacy

Plain words, each backed by a test in `test/privacy.test.mjs`:

- No network. `src/` imports no http, net, dns, child_process or similar, and uses no fetch; a test fails if that changes. No runtime dependencies, no install scripts.
- Logs are read in memory, read-only. The tool never writes into the folders it reads.
- Output holds only counts, shares, dollar estimates, dates, model ids and fixed phrases. Never prompts, assistant text, file paths, project names, commands, env values or tool output. This is tested for the report, `--json`, `--share`, `--explain`, the gate's warning and block reason, `--verbose`, errors, and the scripts.
- Model names come from logs, so only id-shaped names are printed; anything else shows as `other-model`.
- The no-logs message names the agent and a fixed default location (`~/.claude/projects`), or "the folder given with --dir". It does not list real folders.
- The gate's reason may name detected check commands from a fixed list (`npm test`, `npm run lint`, `pytest`, `cargo test`, `go test ./...`, `make test`, ...), never script contents.
- The gate keeps one small state file per session under your OS temp dir (blocking mode only): name is a hash of the session id, contents are a turn timestamp and a counter, mode 0600 (folder 0700).
- Uncaught errors print a generic line and the error class, never the message or a stack trace.
- `install-hook` shows only its own entry, never the rest of your settings, and keeps your file's permissions.
- `--share` is aggregates only, but it is your numbers: read it before posting.

## Known limits

- It cannot see checks run by subagents, CI, or another terminal.
- Test detection is pattern-based; an unusual runner looks like no check. A passing run of the wrong test still counts as proven.
- Completion claims in `report` are English keyword matches near the end of a turn's final message.
- Dollar figures and "avoidable input" are estimates. Prices in `src/prices.json` include rates inferred rather than official; override with `--prices`.
- It does not tell you what any tool would save you, and makes no such promise.

## How the estimates work

Run `apex-context report --explain` for every formula: how tokens are counted once, what counts as a large read (over 4,000 characters, ~4 chars per token), how "carried" context is priced, and how claims are classified. `gate --explain` does the same for the gate.

## FAQ

**Does it send data anywhere?** No. There is no network code, and a test keeps it that way.

**Will it block my agent?** Not by default. The default only warns. Blocking needs `--block` (or `APEX_CONTEXT_GATE_MODE=block`), is limited to 2 blocks per turn, and only triggers for source-code edits in a project with a detectable test runner.

**How do I turn it off?** `APEX_CONTEXT_GATE=off`, or `uninstall-hook --write`.

**Why did it say nothing?** Most turns are allowed silently: no edits, docs/config/test-only edits, scratch files, or no runner found. Add `--verbose` to the hook command to see a one-line reason.

## Development

`npm test`; see [CONTRIBUTING.md](CONTRIBUTING.md), [docs/ADAPTERS.md](docs/ADAPTERS.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md). The repo's `scripts/` (a gate replay and a structure-only turn sampler for maintainers) are not part of the npm package.
