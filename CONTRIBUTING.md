# Contributing

Thanks for helping. This is one project with three parts (report, gate, bench). Read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Dev setup

Node >= 20. There are no dependencies to install.

```sh
git clone <your fork>
cd apex-context
npm test                                   # full suite
node bin/apex-context.mjs report --explain
node bin/apex-context.mjs bench validate examples/bench/tasks
npm pack --dry-run                         # what would ship
```

`npm test` runs `scripts/test.mjs`, which runs every `test/**/*.test.*` file. Use `node --test test/gate.test.mjs` for one file.

## Ground rules

- Zero runtime dependencies. No install scripts.
- `report`, `gate` and `install-hook` code (`src/` except `src/bench/`) makes no network calls and spawns no processes. A test enforces it.
- Output may contain only counts, shares, estimates, model ids and fixed vocabulary. Never paths, project names, prompts, commands, tool output or message text. Every new output path needs a sentinel test in `test/privacy.test.mjs`.
- `bench` never reads agent session logs and imports none of the log-reading code.
- Tests use synthetic fixtures only. Never commit real session logs, and never paste them in issues.
- Estimates are labelled as estimates. No savings or improvement claims without `bench` evidence you can attach.

## Sign-off (DCO)

Every commit needs a sign-off certifying the [Developer Certificate of Origin](DCO):

```sh
git commit -s -m "adapter: add Foo CLI"
```

This adds `Signed-off-by: Your Name <you@example.com>`. Use a name and address you are happy to have in public history.

## Add an agent adapter

An adapter is one module in `src/adapters/`. Follow [docs/ADAPTERS.md](docs/ADAPTERS.md): implement the interface, register it in `src/cli.mjs` and `src/gate.mjs`, add hook wiring in `src/hooks.mjs` if the agent has hooks, add `test/<agent>.test.mjs` with a synthetic fixture, and add sentinel strings to `test/privacy.test.mjs`. In your PR say what you verified against a real session and what only tests cover, and update the status table in the README to match.

## Add a test-runner or language rule

The gate decides "was this proved?" by recognizing check commands (tests, typecheck, lint, build) and which edited files count as source. To add a runner or language, extend the patterns in `src/gate.mjs`, add positive and negative cases to `test/gate.test.mjs` (a command that looks like a check but is not must still count as unchecked), and run `gate --explain` to confirm the printed rules still match. Do not print command text in any output; only names from the fixed list.

## Add benchmark tasks

A task is a folder: `task.json`, `project/`, `hidden/`, `reference/`. Format and rules are in [docs/bench/TASK-FORMAT.md](docs/bench/TASK-FORMAT.md). Before opening a PR:

```sh
node bin/apex-context.mjs bench validate path/to/your/task
```

The unsolved project must fail the hidden tests, the reference must pass them, scoring must be deterministic and need no network. Prefer small tasks in a language or style not yet covered. Put shared example tasks under `examples/bench/tasks/`.

Held-out tasks: a held-out set is only useful if agents have not seen it. Do not submit held-out tasks to this repository. Keep them in a private location outside any folder the agents can read, share only their task-set hash from the run manifest, and run the harness where the agent process cannot see the task folder. Public example tasks are for demos and format checks, not for headline comparisons.

Sharing results: publish the manifest and `results.jsonl` with any number you quote, say how many tasks and runs, and quote the intervals.

## Pull request checklist

- [ ] `npm test` passes on Node 20 and 22 if you can; CI checks both.
- [ ] `npm pack --dry-run` lists only intended files.
- [ ] New output paths have sentinel tests; no paths, commands or text in output.
- [ ] No new dependency, network call, or process spawn in report/gate code.
- [ ] Docs and README status table updated, honestly (live vs tests only).
- [ ] CHANGELOG entry for user-visible changes.
- [ ] Commits are signed off (`git commit -s`).

## What we will not merge

- Network calls in report, gate or install-hook, including telemetry and update checks.
- Anything that reads or prints transcript text, prompts, file paths, project names or commands from logs.
- Runtime dependencies or install scripts.
- Features that write into an agent's session folders.
- Savings, speedup or accuracy claims without evidence from `bench` and a manifest.
- Real session logs or secrets in fixtures.
