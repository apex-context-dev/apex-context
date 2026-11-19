# Changelog

## 0.1.0

First release.

- `report`: token spend, avoidable input, and "done" claims with nothing run after the last edit; `--json`, `--share`, `--explain`, `--since`, `--dir`, `--prices`. Claude Code and Gemini CLI logs.
- `gate`: Claude Code Stop hook and Gemini CLI AfterAgent hook; warns by default, `--block` optional, fails open, `APEX_CONTEXT_GATE=off` disables.
- `install-hook` / `uninstall-hook`: dry run by default, merge-safe, idempotent.
- Privacy audit: no network or process modules (tested), outputs limited to aggregates, model ids sanitized, state files hashed and mode 0600, uncaught errors print only the error class.
