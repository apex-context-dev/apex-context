# apex-context bench

`apex-context bench` is a small, reproducible, vendor-neutral harness for comparing coding-agent setups (a CLI, a model, a prompt, a context tool) on the same tasks. Zero runtime dependencies, Node >= 20. POSIX only (macOS, Linux). It never reads agent session logs; it only runs the commands you give it.

## What it measures

For each arm (a setup under test) on each task, `n` times:

| Metric | How |
|---|---|
| **Pass rate** | The agent runs in a fresh copy of the project. When it stops, hidden tests are copied in and your scoring command runs. Exit 0 = pass. Wilson 95% CI. |
| **Tokens** | Whatever the agent CLI reports about itself, extracted by a regex or a JSON path. `n/a` when the arm reports nothing. Median and mean with a seeded bootstrap 95% CI. |
| **Time** | Wall seconds of the agent command (scoring excluded). Median/mean with bootstrap CI. Runs during which the machine slept are flagged. |
| **False-ready** | The agent claimed it was done and the hidden tests failed. Reported over the runs where the claim is known. `n/a` when the arm has no way to tell; it is never guessed. |

Plus a **paired** comparison of each arm against a baseline, per task.

## Why paired, and why intervals

Tasks differ enormously in difficulty, so comparing two pass rates as if they were independent samples throws away the most useful structure: both arms saw the same tasks. The paired comparison asks only about tasks where the arms disagree. Per task, an arm "passes" if it passes a strict majority of its runs. The **exact McNemar test** is then a two-sided exact binomial test (p = 0.5) on the discordant tasks (only A passes vs only B passes). A **sign test** on per-task pass *rates* is shown next to it because it uses every run, not just the majority. The report also gives the mean per-task pass-rate difference with a bootstrap CI over tasks.

Intervals are there because a benchmark of 10 tasks that says "70% vs 60%" says almost nothing: Wilson 95% for 7/10 is about 40%-89%. When there are fewer than 6 discordant tasks the exact test cannot reach p < 0.05 at all, and the report says "underpowered". More runs per task do not fix that; more tasks do.

## Quick start (no API key)

Run from a clone of the repo or an unpacked npm package (the example tasks ship with both):

```sh
node bin/apex-context.mjs bench validate examples/bench/tasks
node bin/apex-context.mjs bench run examples/bench/tasks --arms oracle,noop,liar --runs 2 --out /tmp/demo --fresh
node bin/apex-context.mjs bench report /tmp/demo --md /tmp/demo/report.md
```

`oracle` applies each task's reference solution, `noop` does nothing, `liar` does nothing and says DONE (so it is false-ready every time). Together they show the whole pipeline: the oracle should score 100%, noop 0%, liar 0% with false-ready 100%.

Commands:

```
apex-context bench run <tasksDir> --arms a,b [--arms-file arms.json] [--runs N] [--tasks substr,substr]
               [--out DIR] [--resume | --fresh] [--dry] [--concurrency 1] [--seed N] [--temperature T]
               [--timeout SEC] [--baseline ARM] [--keep] [--json]
apex-context bench report <outDir> [--baseline ARM] [--json] [--md FILE]
apex-context bench validate <taskDir | tasksDir>
```

`--dry` prints the plan without running. `--resume` continues an interrupted run (cells are keyed by task hash, arm-config hash, run number, seed and temperature, so an edited task or arm reruns). Without `--resume`, an existing `results.jsonl` is refused rather than silently appended to. `--concurrency` defaults to 1: runs share the machine, and parallel runs distort each other's timings. Ctrl-C kills the running agent processes; finished rows are kept.

Output folder: `results.jsonl` (one row per run), `manifest.json` (task-set hash, per-task hashes, arm configs with env values redacted, machine, node, concurrency), `report.md`, `report.json`, and `runs/<task>__<arm>__r<n>/` with `stdout.log`, `stderr.log`, `final.diff`, `score-visible.log`, `score-hidden.log`, `prompt.txt`, `row.json`.

## Adding an agent arm

An arm is a JSON object (or a `.mjs` file whose default export is one) in an `--arms-file`:

```json
{
  "my-agent": {
    "command": "my-agent --prompt-file {promptFile} --dir {cwd}",
    "env": { "MY_AGENT_MODEL": "some-model" },
    "readUsage":   { "type": "regex", "source": "stderr", "in": "input=(\\d+)", "out": "output=(\\d+)" },
    "claimedDone": { "type": "regex", "source": "stdout", "pattern": "^TASK COMPLETE" }
  }
}
```

- `command` runs through `sh -c` with the fresh workspace as the working directory. Placeholders `{prompt}`, `{promptFile}`, `{cwd}`, `{outDir}`, `{steps}`, `{seed}`, `{temperature}`, `{timeout}`, `{taskId}` are substituted already shell-quoted, correct bare or inside quotes. Environment variables `APEX_BENCH_*` carry the same values. The command is responsible for respecting `steps`, `seed` and `temperature`; the harness only passes them along and records them.
- `env` is added to the environment. Its values are hashed into the arm hash but never written to results or the manifest (only the keys).
- `readUsage` (optional): `regex` (first capture group is the number; `mode` is `last` by default, or `sum`; `source` is `stdout`, `stderr` or both) or `json` (`file` is `stdout`, `stderr` or a path like `{outDir}/usage.json` that the command writes; `in`/`out` are dotted paths, or arrays of paths that are summed, e.g. to add cache tokens). Omit it for `n/a`.
- `claimedDone` (optional): `regex` with `pattern` (no match = did not claim) or `json` with `field` (truthy, or `equals`). This is what lets false-ready be computed. If you leave it out, false-ready is `n/a` for that arm. Pick a signal that really means "the agent said it was finished", not just "the process exited".

`examples/bench/arms.example.json` holds copy-paste entries for Claude Code (`claude -p`), Gemini CLI and aider. **They are untested here**: no agent CLI was run while building this package, and flags and output formats change between versions. Check each against your installed version (run one task with `--keep` and read `runs/*/stdout.log`) before trusting a number. In the Claude Code entry, `claimedDone` is only an approximation (a non-empty final result); the Gemini CLI entry reports no usage in that mode, so its tokens are `n/a`.

Agents under test may use the network; the harness itself makes no network calls and only spawns the commands you give it.

## Adding tasks

See [TASK-FORMAT.md](TASK-FORMAT.md). In short: a folder with `task.json`, `project/`, `hidden/`, `reference/`; scoring is any shell command with an exit code, so it works for any language. Run `apex-context bench validate` before using a task: the project must fail the hidden tests, the reference must pass them, and scoring must be deterministic.

## Reproducibility notes

- Every row carries the task hash and arm-config hash; the manifest carries the task-set hash, machine, OS, node version and the full (redacted) arm configs. Publish the manifest and `results.jsonl` with any number you quote, so others can check which tasks and settings produced it.
- The bootstrap is seeded, so `report` is a pure function of `results.jsonl`.
- Cell order is run-major with the arm order rotated per task, so no arm always goes first. Keep concurrency at 1 and the machine plugged in. On macOS the harness warns on battery power (`pmset`), and flags a run as suspended if wall time ran ahead of the monotonic clock by more than 3 seconds.
- Model nondeterminism is not removed. Use several runs per task, and set seed/temperature in the arm command if the agent supports it; the harness records what you pass with `--seed` and `--temperature`.
- Held-out tasks: keep them outside any repository the agents can read, and run the harness somewhere the agent process cannot see the task folder (the harness does not sandbox agents).

## Honest limits

- **Small n.** A few dozen tasks cannot separate close arms. Read the intervals, not the point estimates, and heed "underpowered".
- **Runs are not independent.** Wilson intervals over runs treat repeats of one task as independent trials, which understates uncertainty. The paired per-task tests are the more honest comparison; use them for claims.
- **Task-set bias.** Results describe your tasks (language, size, kind, how the prompt is phrased), not coding agents in general. Rerun with your own tasks before deciding anything.
- **Self-reported tokens.** Tokens come from the agent's own output. Vendors count differently (cache reads, hidden reasoning tokens, retries), so token numbers are comparable only between arms that count the same way, and are `n/a` when an arm reports none. They say nothing about price.
- **"Claimed done" is only as good as your detector.** A regex that matches too loosely or too narrowly biases false-ready in either direction.
- **No sandbox, no network isolation.** Agents run as you. A malicious or careless agent could modify things outside its workspace.
- **Hidden tests define "correct".** A weak hidden test passes wrong solutions; a strict one fails valid ones. Validation catches only the obvious cases.
- **Timing** includes network latency and provider load for hosted models and varies by time of day.
- **Not covered:** concurrency fairness, Windows, tasks that need deleting files in the reference solution, per-turn step counting, cost in money.
