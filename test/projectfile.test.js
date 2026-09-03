'use strict';

/**
 * Project file peek — path resolution is the security boundary (the path
 * arrives over the network and the dashboard is tailnet-reachable), so
 * escapes get explicit coverage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveInProject, readProjectFile } = require('../plugins/golden-eye/server/projectfile');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ge-files-')));
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ge-outside-')));
test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

fs.mkdirSync(path.join(root, 'docs/decisions'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs/decisions/policy.md'), '# Policy\n\nbody\n');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'do not serve me');
fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape-link.txt'));

test('resolveInProject: relative and in-project absolute paths resolve', () => {
  assert.equal(resolveInProject(root, 'docs/decisions/policy.md'), path.join(root, 'docs/decisions/policy.md'));
  assert.equal(resolveInProject(root, './docs/../docs/decisions/policy.md'), path.join(root, 'docs/decisions/policy.md'));
  assert.equal(resolveInProject(root, path.join(root, 'docs/decisions/policy.md')), path.join(root, 'docs/decisions/policy.md'));
});

test('resolveInProject: traversal, absolute escapes and symlinks out are rejected', () => {
  assert.equal(resolveInProject(root, '../../etc/passwd'), null);
  assert.equal(resolveInProject(root, '/etc/passwd'), null);
  assert.equal(resolveInProject(root, path.join(outside, 'secret.txt')), null);
  assert.equal(resolveInProject(root, 'escape-link.txt'), null); // symlink escape not followed
  assert.equal(resolveInProject(root, ''), null);
  assert.equal(resolveInProject(null, 'docs/decisions/policy.md'), null);
});

test('readProjectFile: serves text with metadata, reports missing and escaping paths', () => {
  const ok = readProjectFile(root, 'docs/decisions/policy.md');
  assert.equal(ok.error, undefined);
  assert.equal(ok.relPath, 'docs/decisions/policy.md');
  assert.match(ok.text, /# Policy/);
  assert.equal(ok.truncated, false);

  assert.equal(readProjectFile(root, 'nope.md').error, 'not found');
  assert.equal(readProjectFile(root, '../../etc/passwd').error, 'outside the session project');
  assert.equal(readProjectFile(root, 'escape-link.txt').error, 'outside the session project');
  assert.equal(readProjectFile(root, 'docs').error, 'that path is a directory');
});

test('readProjectFile: binary files are refused, not streamed as mojibake', () => {
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02]));
  assert.equal(readProjectFile(root, 'blob.bin').error, 'binary file');
});
