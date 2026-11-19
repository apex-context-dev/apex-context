export const HELP = `apex-context bench: compare coding-agent setups on the same tasks.

  apex-context bench run <tasksDir> --arms a,b [--arms-file arms.json] [--runs N] [--tasks substr,substr]
                 [--out DIR] [--resume | --fresh] [--dry] [--concurrency 1] [--seed N] [--temperature T]
                 [--timeout SEC] [--baseline ARM] [--keep] [--json]
  apex-context bench report <outDir> [--baseline ARM] [--json] [--md FILE]
  apex-context bench validate <taskDir | tasksDir>
  apex-context bench demo        (bundled example tasks, built-in arms, no API key)

Built-in arms (no API key): oracle, noop, liar. Docs: docs/bench/TASK-FORMAT.md`;
