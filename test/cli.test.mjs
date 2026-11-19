import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Fx } from './helpers.mjs';
import { run } from '../src/cli.mjs';

const SENTINELS = ['SECRET_PROMPT_XYZ', 'SECRET_PROJ_NAME_QQQ', 'secret_file_zzz.js', 'SECRET_ANSWER_TEXT', 'SECRET_CMD_OUT'];

function fixtureDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apxcli-'));
  const dir = path.join(root, '-Users-me-SECRET_PROJ_NAME_QQQ');
  fs.mkdirSync(dir);
  const fx = new Fx('sess').prompt('SECRET_PROMPT_XYZ please')
    .read('/home/me/SECRET_PROJ_NAME_QQQ/secret_file_zzz.js', 40000)
    .edit('/home/me/SECRET_PROJ_NAME_QQQ/secret_file_zzz.js', 'a', 'b')
    .bash('node SECRET_CMD_OUT.js', 'SECRET_CMD_OUT')
    .text('Done. SECRET_ANSWER_TEXT');
  const f = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(f, fx.toString());
  const now = Date.parse('2026-11-05T00:00:00Z');
  fs.utimesSync(f, now / 1000, now / 1000);
  return { root, now };
}
const go = (args, now) => { const o = []; const code = run(args, { out: (s) => o.push(s), err: (s) => o.push(s), isTTY: false, now }); return { code, text: o.join('\n') }; };

test('report, --json and --share contain no paths, names or content', () => {
  const { root, now } = fixtureDir();
  try {
    for (const flags of [[], ['--json'], ['--share'], ['--explain']]) {
      const { code, text } = go(['report', '--dir', root, ...flags], now);
      assert.equal(code, 0);
      for (const s of SENTINELS) assert.ok(!text.includes(s), `${flags} leaked ${s}`);
      assert.ok(!text.includes(root));
      assert.ok(!/\/home\/|\/Users\//.test(text));
    }
    const j = JSON.parse(go(['report', '--dir', root, '--json'], now).text);
    assert.equal(j.completionClaims.claims, 1);
    assert.equal(j.completionClaims.unchecked, 0);
    assert.equal(j.completionClaims.manual, 1);
    assert.equal(j.spend.costIsEstimate, true);
    const share = go(['report', '--dir', root, '--share'], now).text;
    assert.match(share, /estimate/);
    assert.ok(share.split('\n').length <= 6);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('human report labels dollars as estimates', () => {
  const { root, now } = fixtureDir();
  try {
    const { text } = go(['report', '--dir', root], now);
    assert.match(text, /\(about \$[\d.,]+, estimate\)/);
    assert.match(text, /large file reads the agent used little of/);
    assert.match(text, /completion claims/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('no logs: helpful message, exit 0; bad args: exit 2', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'apxempty-'));
  try {
    const r = go(['report', '--dir', empty]);
    assert.equal(r.code, 0);
    assert.match(r.text, /Looked in/);
    assert.equal(go(['report', '--since', 'x']).code, 2);
    assert.equal(go(['report', '--bogus']).code, 2);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});
