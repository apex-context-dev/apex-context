# Roadmap

Directions drawn from this repository's current known gaps. No dates, no promises; order is not priority. Pick one up by opening an issue first.

- **Claude Code live verification.** The Stop-hook gate is covered by tests and assumed from documentation, not verified against a live session. Verify the allow and block paths and update the status table.
- **More agent adapters.** Codex, Cursor and aider (see [docs/ADAPTERS.md](docs/ADAPTERS.md)), for both `report` and `gate` where the agent has hooks.
- **Richer test-runner detection.** More runners and languages for the gate, with fewer false "unchecked" results for unusual setups.
- **Subagent-aware verification.** The gate cannot see checks run by subagents, CI or another terminal.
- **Benchmark second-model results.** Real-agent arms in `bench` are untested; the example arm entries need verifying against installed CLIs, and results from more than one model or agent are needed before any comparison means much.
- **More benchmark tasks.** More languages and task kinds, validated with `bench validate`.
- **Windows support.** `bench` is POSIX only and the hooks are untested on Windows.
