## What and why

## What I verified

Live (real agent session or real run), and what is covered by tests only:

## Checklist

- [ ] `npm test` passes
- [ ] `npm pack --dry-run` lists only intended files
- [ ] New output paths have sentinel tests; no paths, commands or transcript text in output
- [ ] No new dependency, network call or process spawn in report/gate code
- [ ] README status table and docs updated honestly (live vs tests only)
- [ ] CHANGELOG entry for user-visible changes
- [ ] Commits signed off (`git commit -s`, see DCO)
