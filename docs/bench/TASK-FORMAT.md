# Task format

A task is a folder. `apex-context bench run <tasksDir>` treats every subfolder of `<tasksDir>` that contains `task.json` as a task.

```
my-task/
  task.json     id, kind, prompt, timeout, optional steps, and the scoring commands
  project/      the starting files; copied fresh into a temp workspace for every run
  hidden/       tests the agent never sees; copied over the workspace root only after the agent stops
  reference/    files that, laid over project/, solve the task (used by `validate` and the oracle arm)
```

## task.json

```json
{
  "id": "sum-first-n",
  "kind": "fix",
  "title": "Fix sumFirst off-by-one",
  "prompt": "Exactly the text the agent is given. Nothing else is added.",
  "timeout": 600,
  "steps": 40,
  "meta": {
    "visible": "node --test test/visible.test.js",
    "hidden":  "node --test test/hidden.test.js",
    "scoreTimeout": 120
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | `[A-Za-z0-9_.-]+`, unique in the set |
| `kind` | yes | free label (`fix`, `feature`, `refactor`, ...); not interpreted |
| `prompt` | yes | the request, verbatim |
| `timeout` | yes | seconds the agent command may run; the process group is SIGKILLed after that |
| `steps` | no | a turn cap you want every arm to respect. The harness cannot enforce it: it is passed to the arm as `{steps}` and `APEX_BENCH_STEPS` |
| `title` | no | for humans |
| `meta.hidden` | yes | shell command run in the workspace after `hidden/` is copied in. Exit 0 = hidden tests pass |
| `meta.visible` | no | shell command run first, before `hidden/` is copied in (the tests the agent could see). Exit 0 = pass |
| `meta.scoreTimeout` | no | seconds allowed per scoring command (default 120) |

**Pass = hidden exits 0 and (if present) visible exits 0.** Requiring visible tests keeps "fixed the bug, broke the rest" from counting.

Scoring commands are plain POSIX `sh` commands run with the workspace as the working directory, so any language works: `pytest -q hidden_tests`, `cargo test --test hidden`, `go test ./...`, `sh check.sh`. They must not need the network, and they must be deterministic (see `validate`). The environment variable `APEX_BENCH_SCORING=1` is set while scoring.

## Layout rules

- `hidden/` is overlaid onto the workspace root with its relative paths kept: `hidden/test/hidden.test.js` lands at `test/hidden.test.js`. It must not collide with a file in `project/`.
- `project/` must not contain anything from `hidden/` or `reference/`.
- `reference/` is overlaid on `project/` the same way (files replaced or added; deleting a file is not supported, so make tasks whose solution only adds or edits files).
- A task hash (sha256 of every file in the task folder) is stored in every result row. Edit a task and its hash changes: old rows no longer match, and `--resume` reruns it. Treat published tasks as frozen and make a new id instead of editing.
- `node_modules`, `.git`, `__pycache__`, `.pytest_cache` and `.DS_Store` are ignored when hashing and diffing.

## What the agent gets

The arm command runs with the workspace as its working directory. Placeholders in `command` are replaced by shell-quoted values (they are safe bare, in double quotes or in single quotes): `{prompt}`, `{promptFile}` (the prompt as a file outside the workspace), `{cwd}`, `{outDir}` (a scratch folder outside the workspace for files the agent command writes, e.g. a usage JSON), `{steps}`, `{seed}`, `{temperature}`, `{timeout}`, `{taskId}`. `{taskDir}` and `{benchSrc}` exist only for the built-in oracle; a real arm must not use `{taskDir}`, since it contains `hidden/`.

The same values are exported as `APEX_BENCH_PROMPT`, `APEX_BENCH_PROMPT_FILE`, `APEX_BENCH_CWD`, `APEX_BENCH_OUT`, `APEX_BENCH_TASK`, `APEX_BENCH_STEPS`, `APEX_BENCH_SEED`, `APEX_BENCH_TEMPERATURE`, `APEX_BENCH_TIMEOUT`.

The harness does not sandbox the agent. An agent running as you can read anything you can, including a task folder on disk. If that matters (it does for held-out tasks), run the harness in a container or a separate account with only the workspace visible.

## Validating

`apex-context bench validate <taskDir>` (or a folder of tasks) checks that:

1. `task.json` is well formed and `hidden/` and `reference/` are non-empty;
2. no file of `hidden/` exists in `project/`, and `project/` holds no `hidden/` or `reference/` folder;
3. the hidden command **fails** on `project/` as given;
4. the hidden command and the visible command **pass** with `reference/` overlaid;
5. scoring is deterministic: both `project/` and `project+reference/` are scored twice with the same outcome.

It exits non-zero on any problem.
