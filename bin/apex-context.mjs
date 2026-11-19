#!/usr/bin/env node
// Uncaught errors must never print transcript text (messages can contain paths or content):
// print a generic line plus the error class only.
try {
  const { run } = await import('../src/cli.mjs');
  process.exitCode = run(process.argv.slice(2));
} catch (e) {
  const cls = e && e.constructor && /^[A-Za-z]{1,30}$/.test(e.constructor.name) ? e.constructor.name : 'Error';
  process.stderr.write(`apex-context: unexpected error (${cls}). Nothing was changed. Run with --help for usage.\n`);
  process.exitCode = 1;
}
