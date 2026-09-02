'use strict';

/**
 * History browser tests — the dir-parameter validation is a security boundary
 * (it gates filesystem reads from the network), so it gets explicit coverage.
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GOLDEN_EYE_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'golden-eye-test-'));
const { listProjects, resolveProjectDir, listSessions, resolveTranscript } = require('../plugins/golden-eye/server/history');

// Fake Claude Code transcript store: <root>/projects/<slug>/<sid>.jsonl
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-eye-hist-'));
const root = path.join(base, 'projects');
const projA = path.join(root, '-tmp-proj-a');
fs.mkdirSync(projA, { recursive: true });

function writeTranscript(dir, sid, cwd, prompt) {
  const lines = [
    JSON.stringify({ type: 'user', cwd, timestamp: '2026-01-01T10:00:00Z', message: { content: prompt } }),
    JSON.stringify({ type: 'assistant', cwd, timestamp: '2026-01-01T10:00:05Z', message: { content: [{ type: 'text', text: 'ok' }] } }),
  ];
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), lines.join('\n') + '\n');
}
writeTranscript(projA, 'sess-one', '/tmp/proj-a', 'first prompt here');
writeTranscript(projA, 'sess-two', '/tmp/proj-a', 'second prompt');
// Noise that must never be listed: subagent dir, meta file.
fs.mkdirSync(path.join(projA, 'sess-one'), { recursive: true });
fs.writeFileSync(path.join(projA, 'sess-one.meta.json'), '{}');

// Store stub: one observed session reveals the projects root.
const store = {
  sessions: new Map([
    ['sess-one', { transcriptPath: path.join(projA, 'sess-one.jsonl') }],
  ]),
};

test('listProjects derives the root from observed transcripts and recovers the real cwd', () => {
  const projects = listProjects(store);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].dir, projA);
  assert.equal(projects[0].cwd, '/tmp/proj-a'); // from the transcript head, not the lossy slug
  assert.equal(projects[0].sessions, 2);
});

test('listSessions lists transcripts newest-first with peeked prompts, marking live ones', () => {
  const sessions = listSessions(store, projA);
  assert.equal(sessions.length, 2);
  const one = sessions.find((s) => s.id === 'sess-one');
  assert.equal(one.live, true);
  assert.equal(one.firstPrompt, 'first prompt here');
  assert.equal(sessions.find((s) => s.id === 'sess-two').live, false);
});

test('resolveProjectDir rejects anything but a direct child of a derived root', () => {
  assert.equal(resolveProjectDir(store, projA), fs.realpathSync(projA));
  assert.equal(resolveProjectDir(store, root), null); // the root itself
  assert.equal(resolveProjectDir(store, base), null); // above the root
  assert.equal(resolveProjectDir(store, os.tmpdir()), null); // unrelated
  assert.equal(resolveProjectDir(store, path.join(projA, 'sess-one')), null); // too deep
  assert.equal(resolveProjectDir(store, projA + '/../../projects/-tmp-proj-a'), fs.realpathSync(projA)); // normalizes, still valid
  assert.equal(resolveProjectDir(store, '/etc'), null);
  assert.equal(resolveProjectDir(store, ''), null);
});

test('resolveTranscript requires a filename-shaped id', () => {
  assert.equal(resolveTranscript(store, projA, 'sess-two'), path.join(fs.realpathSync(projA), 'sess-two.jsonl'));
  assert.equal(resolveTranscript(store, projA, '../evil'), null);
  assert.equal(resolveTranscript(store, projA, 'a/b'), null);
  assert.equal(resolveTranscript(store, projA, ''), null);
});
