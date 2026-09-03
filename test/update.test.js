'use strict';

/**
 * Update reporting — version comparison and install-path detection decide
 * which command a user is told to run, so both get pinned.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GOLDEN_EYE_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'golden-eye-test-'));
const { cmpVersions, installKind, updateCommand, installedNewerThanRunning } =
  require('../plugins/golden-eye/server/update');

test('cmpVersions orders numerically, not lexically', () => {
  assert.equal(cmpVersions('0.1.4', '0.1.4'), 0);
  assert.equal(cmpVersions('0.1.5', '0.1.4'), 1);
  assert.equal(cmpVersions('0.1.4', '0.1.5'), -1);
  // The classic string-compare bug: "0.1.10" < "0.1.9" alphabetically.
  assert.equal(cmpVersions('0.1.10', '0.1.9'), 1);
  assert.equal(cmpVersions('0.10.0', '0.9.9'), 1);
  assert.equal(cmpVersions('1.0.0', '0.99.99'), 1);
  // Missing/garbage parts must not throw or invent an ordering.
  assert.equal(cmpVersions('0.1', '0.1.0'), 0);
  assert.equal(cmpVersions(null, undefined), 0);
});

test('installKind maps a code path to the command that actually updates it', () => {
  assert.equal(installKind('/Users/x/.golden-eye/app/plugins/golden-eye/server'), 'npx');
  assert.equal(installKind('/Users/x/.claude/plugins/cache/claude-golden-eye/golden-eye/0.1.4/server'), 'marketplace');
  assert.equal(installKind('/Users/x/Projects/claude-golden-eye/plugins/golden-eye/server'), 'source');

  assert.match(updateCommand('npx'), /npx claude-golden-eye@latest init/);
  assert.match(updateCommand('marketplace'), /claude plugin update/);
  assert.match(updateCommand('source'), /git pull/);
});

test('installedNewerThanRunning spots a server left behind by an update', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-vers-'));
  const cache = path.join(root, 'golden-eye');
  for (const v of ['0.1.3', '0.1.4', '0.1.10']) fs.mkdirSync(path.join(cache, v, 'server'), { recursive: true });

  // Running 0.1.4 while 0.1.10 sits beside it: stale, and picked numerically.
  assert.deepEqual(installedNewerThanRunning(path.join(cache, '0.1.4', 'server')), {
    running: '0.1.4',
    installed: '0.1.10',
  });
  // Running the newest: nothing to report.
  assert.equal(installedNewerThanRunning(path.join(cache, '0.1.10', 'server')), null);
  // A source checkout has no version directory to compare.
  assert.equal(installedNewerThanRunning('/Users/x/Projects/claude-golden-eye/plugins/golden-eye/server'), null);

  fs.rmSync(root, { recursive: true, force: true });
});
