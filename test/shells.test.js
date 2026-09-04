'use strict';

/**
 * Background command state read from Claude Code's per-task output file.
 * The exit marker is what retires a shell, so a missed completion notice can
 * no longer strand one as "running" forever.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GOLDEN_EYE_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'golden-eye-test-'));
const { EXIT_RE } = require('../plugins/golden-eye/server/shells');

test('the exit marker is what proves a background command finished', () => {
  assert.equal(EXIT_RE.test('some output\n\n[exited with code 0]\n'), true);
  assert.equal(EXIT_RE.exec('x\n[exited with code 0]')[1], '0');
  assert.equal(EXIT_RE.exec('x\n[exited with code 127]')[1], '127');
  assert.equal(EXIT_RE.exec('x\n[exited with code -1]')[1], '-1');
  // Still streaming: no marker yet, however much output has accumulated.
  assert.equal(EXIT_RE.test('Waiting for rollout...\nWaiting for rollout...\n'), false);
  // Prose mentioning an exit code is not a marker.
  assert.equal(EXIT_RE.test('the command exited with code 0 eventually'), false);
});

test('shellStatus reads output and completion from a real task file', () => {
  // Mirror the layout Claude Code writes: <tmp>/claude-<uid>/<slug>/<sess>/tasks/<id>.output
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-shells-'));
  const uidDir = path.join(root, 'claude-501');
  const tasks = path.join(uidDir, '-tmp-proj', 'sess-1', 'tasks');
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, 'brunning1.output'), 'still going\nmore output\n');
  fs.writeFileSync(path.join(tasks, 'bdone1.output'), 'READY branch=main clean\n\n[exited with code 0]\n');

  // Point the resolver at this fake tree via TMPDIR, in a fresh module
  // instance so its path cache starts empty.
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = root;
  delete require.cache[require.resolve('../plugins/golden-eye/server/shells')];
  const { shellStatus } = require('../plugins/golden-eye/server/shells');

  const running = shellStatus('brunning1', '/tmp/proj');
  assert.equal(running.done, false);
  assert.equal(running.exitCode, null);
  assert.match(running.output, /still going/);

  const done = shellStatus('bdone1', '/tmp/proj');
  assert.equal(done.done, true);
  assert.equal(done.exitCode, 0);
  assert.equal(done.output, 'READY branch=main clean'); // marker stripped
  assert.doesNotMatch(done.output, /exited with code/);

  // Unknown id: null, so the caller keeps whatever it already knew rather
  // than wrongly retiring a shell whose file it simply could not find.
  assert.equal(shellStatus('bmissing', '/tmp/proj'), null);
  // Ids are used to build a path, so they must stay filename-shaped.
  assert.equal(shellStatus('../../etc/passwd', '/tmp/proj'), null);

  if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
  fs.rmSync(root, { recursive: true, force: true });
});
