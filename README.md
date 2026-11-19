# apex-context

A coding agent shouldn't be able to say "done" without proof. apex-context measures how often yours did, warns when it happens, and ships the benchmark harness to check whether any fix actually helps.

Local, read-only report and hook, no network, zero dependencies, Node >= 20, Apache-2.0.

This open project is separate from Apex Capsule IDE, a commercial desktop app; nothing here requires it.

## 60-second quickstart

```sh
npx apex-context report              # last 30 days of Claude Code logs; nothing to configure
```

The hook is a command your agent runs later, so install the tool somewhere permanent first (an `npx` copy lives in a cache that can be cleared), then add the hook:

```sh
npm install -g apex-context
apex-context install-hook            # dry run: prints the hook entry and the file it would go in
apex-context install-hook --write    # optional: apply it (./.claude/settings.json; --user for ~/.claude)
```

Then the benchmark demo, which needs no API key and works from any folder because it uses the example tasks that ship with the package:

```sh
npx apex-context bench demo
```

(From a clone, `node bin/apex-context.mjs bench demo` does the same; `bench validate examples/bench/tasks` and `bench run ...` take your own task folders.)

Nothing is written to your agent settings unless you pass `--write`. Remove the hook with `uninstall-hook --write`; pause it with `APEX_CONTEXT_GATE=off`.

## How it works

Three parts, one idea.

- **report** reads your local agent logs (read-only) and prints aggregates: token spend, large file reads the agent used little of, and "done" claims with no passing check after the last edit.
- **gate** is a Stop/AfterAgent hook. After each turn it asks: was source code edited, and did a test, typecheck, lint or build run afterwards? If not, it warns (default) or, with `--block`, asks the agent to run the checks first. It fails open.
- **bench** runs the same tasks under different agent setups (a CLI, a model, a prompt, a hook), scores them with hidden tests, and reports pass rate, tokens, time and false-ready ("claimed done, hidden tests failed") with confidence intervals and paired comparisons.

They connect: report shows the problem in your own logs, gate acts on it, and bench is the evidence for or against the gate. Whether a gate or any other setup reduces false-ready is a question for `bench` to answer with numbers, not a claim this README makes.

Reference: `apex-context --help`, `apex-context <command> --help`, [docs/bench/README.md](docs/bench/README.md), [docs/bench/TASK-FORMAT.md](docs/bench/TASK-FORMAT.md), [docs/ADAPTERS.md](docs/ADAPTERS.md). `report --explain` and `gate --explain` print every formula and rule.

## Status: what is verified, and how

| Area | Verified live | Verified by tests only |
|---|---|---|
| report, Claude Code logs | Run on real local logs | Synthetic fixtures |
| report, Gemini CLI logs | - | Synthetic fixtures |
| gate, Claude Code (Stop hook) | **Not yet.** Hook contract is assumed from documentation | Allow and block paths |
| gate, Gemini CLI (AfterAgent hook) | Block path, on Gemini CLI 0.32.1 | Allow path |
| install-hook / uninstall-hook | - | Dry run, merge, idempotence, invalid JSON |
| bench with built-in arms (oracle, noop, liar) | - | Pipeline, statistics, validation, packed demo |
| bench with real agents (Claude Code, Gemini CLI, aider) | **Not yet.** `examples/bench/arms.example.json` entries are untested | - |
| Windows | **Not supported** (bench is POSIX only; hooks untested) | - |

Gemini note: headless `-p` with auto-edit approval does not offer the shell tool, so an agent cannot run tests there; a blocking gate can only be satisfied in interactive mode, with `--yolo`, or with an allow-list.

## Known limits

- The gate cannot see checks run by subagents, CI, or another terminal.
- Test detection is pattern-based; an unusual runner looks like no check. A passing run of the wrong test still counts as proven.
- Completion claims in `report` are English keyword matches near the end of a turn's final message.
- Dollar figures and "avoidable input" are estimates. `src/prices.json` includes inferred rates; override with `--prices`.
- Bench results describe your tasks and your setup, not agents in general. A few dozen tasks cannot separate close arms; read the intervals and the "underpowered" notes. Bench does not sandbox agents. See [docs/bench/README.md](docs/bench/README.md#honest-limits).
- It does not promise savings or improvement for any setup.

## Privacy

Each point is backed by a test in `test/privacy.test.mjs`.

- No network. `report`, `gate` and `install-hook` import no http, net, dns, child_process or similar, and use no fetch. `bench` may spawn only the commands you give it as arms and scoring commands, imports no network module, and makes no network calls itself (the agents you run may).
- `bench` never reads agent session logs; a test runs it with sentinel logs under a temporary HOME and checks nothing leaks.
- Logs are read in memory, read-only. The tool never writes into the folders it reads.
- Output holds only counts, shares, dollar estimates, dates, model ids and fixed phrases. Never prompts, assistant text, file paths, project names, commands, env values or tool output.
- The gate keeps one small state file per session under your OS temp dir (blocking mode only): hashed name, a timestamp and a counter, mode 0600.
- Uncaught errors in `report` and `gate` print a generic line and the error class only.
- `--share` is aggregates only, but it is your numbers: read it before posting.

## Contributing

Concrete ways to help (see [CONTRIBUTING.md](CONTRIBUTING.md)):

- **A new agent adapter** (Codex, Cursor, aider, others): one module, see [docs/ADAPTERS.md](docs/ADAPTERS.md).
- **Test runner and language detection**: teach the gate more ways to recognize a real check.
- **Benchmark tasks**: small, deterministic tasks in any language, plus held-out sets.
- **Results from other models and agents**: run `bench` with your own arms and share the manifest and `results.jsonl`.
- **Verification on real sessions**: especially the Claude Code Stop hook.

Start with issues labelled "good first issue". Also see [ROADMAP.md](ROADMAP.md), [GOVERNANCE.md](GOVERNANCE.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [SUPPORT.md](SUPPORT.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md).

## Development

```sh
npm test
npm pack --dry-run
```

The repo's `scripts/` (a gate replay and a structure-only turn sampler for maintainers) are not part of the npm package.

## License

Apache-2.0, see [LICENSE](LICENSE).
