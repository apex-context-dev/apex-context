# Contributing

Requirements: Node >= 20. There are no dependencies to install.

```sh
npm test                       # full suite (node --test)
node bin/apex-context.mjs report --explain
npm pack --dry-run             # check what would be published
```

Ground rules

- Zero runtime dependencies. No network, no child processes in `src/` (a test enforces it).
- Output may contain only counts, shares, estimates, model ids and fixed vocabulary. Never paths, project names, prompts, commands or message text. Any new output path needs a sentinel test in `test/privacy.test.mjs`.
- Tests use synthetic fixtures only. Do not commit real session logs.
- Estimates must be labelled as estimates.

Adding an agent: see [docs/ADAPTERS.md](docs/ADAPTERS.md).

Pull requests: describe what you verified live and what only tests cover. Say so plainly in the README's support table if the behaviour is not verified against a real session.
