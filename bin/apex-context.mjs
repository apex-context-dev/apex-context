#!/usr/bin/env node
// `bench` is the only command that spawns processes (the agent commands you give it); it is loaded
// lazily so report/gate/install-hook never import it. It never reads agent session logs.
const argv = process.argv.slice(2);
if (argv[0] === 'bench') {
  try {
    const { main } = await import('../src/bench/cli.mjs');
    const code = await main(argv.slice(1));
    process.exit(code ?? 0);
  } catch (e) {
    process.stderr.write(`apex-context bench: ${e && e.message ? e.message : 'unexpected error'}\n`);
    process.exit(2);
  }
}
// Uncaught errors must never print transcript text (messages can contain paths or content):
// print a generic line plus the error class only.
try {
  const { run } = await import('../src/cli.mjs');
  process.exitCode = run(argv);
} catch (e) {
  const cls = e && e.constructor && /^[A-Za-z]{1,30}$/.test(e.constructor.name) ? e.constructor.name : 'Error';
  process.stderr.write(`apex-context: unexpected error (${cls}). Nothing was changed. Run with --help for usage.\n`);
  process.exitCode = 1;
}
