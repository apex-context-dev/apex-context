import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Fx } from './helpers.mjs';
import * as claude from '../src/adapters/claude-code.mjs';
import { computeSpend, computeAvoidable, computeDone, priceFor, isTestCommand, claimsDone, claimWord, looksFailed, isBashEdit, computeAll } from '../src/metrics.mjs';
import { loadSessions, parseSince } from '../src/load.mjs';

const prices = JSON.parse(fs.readFileSync(new URL('../src/prices.json', import.meta.url), 'utf8'));
const parse = (fx) => claude.parseSession(fx.toString(), { file: 'f' });

test('tolerant parsing: malformed and unknown lines are counted, not fatal', () => {
  const fx = new Fx().prompt().raw({ type: 'weird-new-type', x: 1 }).text('hello');
  const txt = fx.toString() + '{not json\n[1,2]\n\n';
  const s = claude.parseSession(txt, { file: 'f' });
  assert.equal(s.stats.malformed, 2);
  assert.equal(s.stats.skipped, 1);
  assert.equal(s.turns.length, 2);
});

test('usage summation dedupes multi-block messages and sums across messages', () => {
  const fx = new Fx().prompt()
    .assistant([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], { usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: 7 } })
    .text('c', { usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 } });
  const sp = computeSpend([parse(fx)], prices);
  assert.deepEqual(sp.total, { input: 11, cacheRead: 1002, cacheCreate: 53, output: 11 });
});

test('price table: known model priced, unknown excluded and flagged', () => {
  const fx = new Fx().prompt()
    .text('a', { model: 'claude-sonnet-5-5', usage: { input_tokens: 1e6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } })
    .text('b', { model: 'mystery-model-9', usage: { input_tokens: 1e6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } });
  const sp = computeSpend([parse(fx)], prices);
  assert.equal(sp.costUsd, prices.models['claude-sonnet-5'].input);
  assert.deepEqual(sp.unknownModels, ['mystery-model-9']);
  assert.equal(sp.perModel['mystery-model-9'].priced, false);
  assert.equal(priceFor('claude-opus-5-5', prices).input, prices.models['claude-opus-5'].input);
  assert.equal(priceFor('nope', prices), null);
});

test('avoidable: large read, small edit counts a share; big edit counts none', () => {
  const small = new Fx().prompt().read('/p/a.js', 40000, 1000).edit('/p/a.js', 'x', 'y').text('ok');
  const r = computeAvoidable([parse(small)], prices);
  // 10000 tokens; edited 1/1000 lines -> 1 - (0.25 + 0.004)
  assert.ok(r.tokens > 7000 && r.tokens < 7500, String(r.tokens));
  assert.ok(r.costUsd > 0);
  // result.lines comes from content line count (~800 lines of 50 chars)
  const big = new Fx().prompt().read('/p/b.js', 40000).edit('/p/b.js', Array(300).fill('l').join('\n'), 'y');
  assert.equal(computeAvoidable([parse(big)], prices).tokens, 0);
});

test('avoidable: small reads ignored; partial (offset/limit) reads ignored', () => {
  const fx = new Fx().prompt().read('/p/s.js', 1000)
    .tool('Read', { file_path: '/p/l.js', offset: 1, limit: 50 }, { content: 'x'.repeat(30000) });
  assert.equal(computeAvoidable([parse(fx)], prices).tokens, 0);
});

test('avoidable: read never used counts half; mention later counts zero', () => {
  const never = new Fx().prompt().read('/p/n.js', 40000).text('done');
  assert.equal(computeAvoidable([parse(never)], prices).tokens, 5000);
  const used = new Fx().prompt().read('/p/n.js', 40000).bash('grep foo n.js').text('x');
  assert.equal(computeAvoidable([parse(used)], prices).tokens, 0);
});

test('avoidable: unchanged re-read counts fully; changed file does not', () => {
  const same = new Fx().prompt().read('/p/r.js', 40000).bash('ls').read('/p/r.js', 40000).text('x');
  const a = computeAvoidable([parse(same)], prices);
  assert.equal(a.redundantRereads, 1);
  assert.ok(a.tokens >= 10000);
  const changed = new Fx().prompt().read('/p/r.js', 40000).edit('/p/r.js', 'a', 'b').read('/p/r.js', 40000).text('x');
  assert.equal(computeAvoidable([parse(changed)], prices).redundantRereads, 0);
});

test('test command and failure detection', () => {
  for (const c of ['npm test', 'pnpm run test:unit', 'yarn lint', 'pytest -q', 'go test ./...', 'cargo test', 'npx tsc --noEmit', 'node --test test/', 'npx vitest run', './gradlew test', 'make test', 'cd x && npm run build'])
    assert.ok(isTestCommand(c), c);
  for (const c of ['ls -la', 'git status', 'cat package.json', 'echo hi']) assert.ok(!isTestCommand(c), c);
  assert.ok(looksFailed({ isError: true, tail: '' }));
  assert.ok(looksFailed({ isError: false, tail: '# fail 2' }));
  assert.ok(looksFailed({ isError: false, tail: 'error TS2322: nope' }));
  assert.ok(!looksFailed({ isError: false, tail: '# pass 10\n# fail 0\n0 failed' }));
  assert.ok(claimsDone('All done, it is fixed.'));
  assert.ok(!claimsDone('This is not done yet.'));
  assert.ok(claimsDone('Added the unit tests, they are passing.'));
  assert.ok(!claimsDone('I looked at the file and have a question.'));
});

test('claim detector: window, dropped words, negation', () => {
  assert.equal(claimWord('x'.repeat(400) + ' all done'), 'done');
  assert.equal(claimWord('it is done ' + 'x'.repeat(400)), null); // outside the last 300 chars
  assert.equal(claimWord('Ready for review. It passes locally.'), null);
  assert.equal(claimWord('This is not done yet'), null);
});

test('bash edits are detected as edits; logs and reads are not', () => {
  for (const c of ["sed -i '' 's/a/b/' x.js", 'perl -pi -e "s/a/b/" x.js', 'echo hi > out.txt', 'cat a | tee b.js', 'git apply x.patch', 'git checkout -- x.js', "python3 -c \"open('f','w').write('x')\"", 'node -e "fs.writeFileSync(1,2)"'])
    assert.ok(isBashEdit(c), c);
  for (const c of ['npm test > run.log 2>&1', 'ls -la', 'grep foo x.js', 'cat x.js | head', 'echo hi > /dev/null', 'node a.js 2>&1', 'sed -n 1,5p x.js'])
    assert.ok(!isBashEdit(c), c);
});

test('done: test after edit passes -> proven', () => {
  const fx = new Fx().prompt().edit('/p/a.js').bash('npm test', '# pass 3\n# fail 0').text('Done, all tests passing.');
  const d = computeDone([parse(fx)]);
  assert.deepEqual([d.claims, d.proven, d.unchecked, d.manual, d.failed], [1, 1, 0, 0, 0]);
});

test('done: test only before the edit -> unchecked', () => {
  const fx = new Fx().prompt().bash('npm test', 'ok').edit('/p/a.js').text('Fixed.');
  const d = computeDone([parse(fx)]);
  assert.deepEqual([d.claims, d.proven, d.unchecked], [1, 0, 1]);
  assert.equal(d.uncheckedShare, 1);
});

test('done: failing test after edit -> failed, via flag/exit code and via text', () => {
  const a = new Fx().prompt().edit('/p/a.js').bash('npm test', 'Exit code 1\nboom', true).text('Implemented.');
  const b = new Fx().prompt().edit('/p/a.js').bash('pytest -q | tail', '2 failed, 3 passed').text('Complete.');
  const d = computeDone([parse(a), parse(b)]);
  assert.deepEqual([d.claims, d.failed], [2, 2]);
  assert.equal(parse(a).turns.find((t) => t.toolCalls[0]?.name === 'Bash').toolCalls[0].result.exitCode, 1);
});

test('exit status 0 is trusted without a pipe, text checked with a pipe', () => {
  assert.equal(looksFailed({ isError: false, exitCode: 0, tail: '2 failed' }, 'npm test'), false);
  assert.equal(looksFailed({ isError: false, exitCode: 0, tail: '2 failed' }, 'npm test | tail'), true);
});

test('done: manual check (script, grep, browser tool) -> manually checked', () => {
  const a = new Fx().prompt().edit('/p/a.js').bash('node scripts/x.js').text('Done.');
  const b = new Fx().prompt().edit('/p/a.js').tool('mcp__Claude_Browser__computer', { action: 'screenshot' }).text('Fixed.');
  const d = computeDone([parse(a), parse(b)]);
  assert.deepEqual([d.claims, d.manual, d.unchecked], [2, 2, 0]);
});

test('done: bash edit counts as the last edit (test before it does not prove)', () => {
  const fx = new Fx().prompt().edit('/p/a.js').bash('npm test').bash("sed -i '' 's/a/b/' a.js").text('Done.');
  const d = computeDone([parse(fx)]);
  assert.deepEqual([d.claims, d.unchecked], [1, 1]);
});

test('done: no edits or no claim are excluded; turns counted separately', () => {
  const noEdit = new Fx().prompt().bash('ls').text('Done.');
  const noClaim = new Fx().prompt().edit('/p/a.js').text('Here is what I changed, what next?');
  const two = new Fx().prompt().edit('/p/a.js').bash('npm test').text('Fixed.').prompt('again').edit('/p/b.js').text('Done.');
  const d = computeDone([parse(noEdit), parse(noClaim), parse(two)]);
  assert.deepEqual([d.claims, d.proven, d.unchecked, d.segmentsNoClaim], [2, 1, 1, 1]);
});

test('carried context: later calls until compaction, priced at cache-read rate', () => {
  const u = (cr) => ({ input_tokens: 1, cache_read_input_tokens: cr, cache_creation_input_tokens: 0, output_tokens: 1 });
  const fx = new Fx().prompt().read('/p/n.js', 40000)       // 10000 tokens, never used -> 5000 avoidable
    .text('a', { usage: u(100000) }).text('b', { usage: u(110000) }).text('c', { usage: u(10000) }); // compaction before c
  const a = computeAvoidable([parse(fx)], prices);
  assert.equal(a.tokens, 5000);
  // the read is issued in a call with default usage (cacheRead 100), later calls: a(100000), b(110000); c dropped >50% => stop
  assert.equal(a.carriedTokenCalls, 5000 * 2);
  const expected = 5000 * 2 * prices.models['claude-sonnet-5'].cacheRead / 1e6;
  assert.ok(Math.abs(a.carriedCostUsd - expected) < 1e-9);
  const all = computeAll([parse(fx)], prices);
  assert.ok(all.avoidable.carriedShareOfCacheReadSpend > 0);
});

test('--since parsing and filtering by mtime and timestamp', () => {
  assert.equal(parseSince('30d'), 30 * 86400e3);
  assert.equal(parseSince('12h'), 12 * 3600e3);
  assert.equal(parseSince('bogus'), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apxctx-'));
  try {
    const fx = new Fx('a').prompt().text('hi'); // timestamps Nov 1 2026
    const f1 = path.join(dir, 'new.jsonl'); fs.writeFileSync(f1, fx.toString());
    const f2 = path.join(dir, 'old.jsonl'); fs.writeFileSync(f2, new Fx('b').prompt().text('hi').toString());
    const now = Date.parse('2026-11-05T00:00:00Z');
    fs.utimesSync(f1, now / 1000, now / 1000);
    fs.utimesSync(f2, (now - 90 * 86400e3) / 1000, (now - 90 * 86400e3) / 1000);
    const r30 = loadSessions({ dirs: [dir], sinceMs: 30 * 86400e3, now, adapter: claude });
    assert.equal(r30.sessions.length, 1);
    const r100 = loadSessions({ dirs: [dir], sinceMs: 100 * 86400e3, now, adapter: claude });
    assert.equal(r100.sessions.length, 2);
    const r1 = loadSessions({ dirs: [dir], sinceMs: 1 * 86400e3, now: now + 40 * 86400e3, adapter: claude });
    assert.equal(r1.sessions.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
