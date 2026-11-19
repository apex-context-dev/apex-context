# Changelog

## 0.2.0

- Merged the benchmark harness into this package as `apex-context bench` (`run`, `validate`, `report`). Code in `src/bench/`, docs in `docs/bench/`, example tasks and arms in `examples/bench/`, tests in `test/bench/`. Still zero runtime dependencies; `bench` is loaded only when invoked and never reads agent session logs.
- Privacy tests now separate report/gate/install-hook (no network, no process spawning) from `bench` (no network, no log-reading code, spawns only user-supplied commands) and check bench outputs against sentinel logs.
- `npm test` runs through `scripts/test.mjs` so example tasks' hidden tests are not collected.
- Community files: CODE_OF_CONDUCT, CONTRIBUTING (with DCO), GOVERNANCE, ROADMAP, SUPPORT, issue and PR templates, CI workflow, label list.
- README rewritten as one project README.

## 0.1.0

First release.

- `report`: token spend, avoidable input, and "done" claims with nothing run after the last edit; `--json`, `--share`, `--explain`, `--since`, `--dir`, `--prices`. Claude Code and Gemini CLI logs.
- `gate`: Claude Code Stop hook and Gemini CLI AfterAgent hook; warns by default, `--block` optional, fails open, `APEX_CONTEXT_GATE=off` disables.
- `install-hook` / `uninstall-hook`: dry run by default, merge-safe, idempotent.
- Privacy audit: no network or process modules (tested), outputs limited to aggregates, model ids sanitized, state files hashed and mode 0600, uncaught errors print only the error class.
