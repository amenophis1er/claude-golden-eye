'use strict';

/**
 * Transcript tail parser: fed hostile input by design (partial lines, format
 * drift across Claude Code versions), so tolerance and the derived stats
 * (usage sums, context high-water → window inference) are pinned here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { tailTranscript, sessionStats, agentMeta, artifactsFromTranscript } = require('../plugins/golden-eye/server/transcript');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-transcript-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function writeTranscript(lines) {
  const file = path.join(tmp, `t${++n}.jsonl`); // fresh path defeats the stats TTL cache
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}

const assistant = (over = {}) => ({
  type: 'assistant',
  timestamp: '2026-09-01T10:00:00Z',
  gitBranch: 'main',
  version: '2.1.240',
  message: {
    model: 'claude-fable-5',
    usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 20 },
    content: [{ type: 'text', text: 'hello world' }],
    ...over.message,
  },
  ...over,
});

test('tailTranscript: entries, model, branch, usage sums from a healthy file', () => {
  const file = writeTranscript([
    assistant(),
    assistant({
      message: {
        model: 'claude-fable-5',
        usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 200, output_tokens: 4 },
        content: [
          { type: 'thinking', thinking: 'pondering…' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    }),
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'file-a\nfile-b', is_error: false }] } },
  ]);
  const t = tailTranscript(file);
  assert.equal(t.exists, true);
  assert.equal(t.model, 'claude-fable-5');
  assert.equal(t.branch, 'main');
  assert.deepEqual(t.usage, { in: 16, cacheRead: 300, out: 24 }); // (10+5)+(1+0), 100+200, 20+4
  assert.equal(t.contextTokens, 201); // last request: 1+0+200
  assert.deepEqual(
    t.entries.map((e) => e.kind),
    ['text', 'thinking', 'tool', 'result']
  );
  assert.equal(t.entries[3].isError, false);
});

test('tailTranscript: garbage lines and unknown shapes are skipped, not fatal', () => {
  const file = writeTranscript([
    'this is not json at all {{{',
    { type: 'summary', unrelated: true },
    '{"type":"assistant","message":null}',
    assistant(),
    '{"truncated": ',
  ]);
  const t = tailTranscript(file);
  assert.equal(t.exists, true);
  assert.equal(t.entries.length, 1);
  assert.equal(t.entries[0].text, 'hello world');
});

test('tailTranscript: missing file reports not-found instead of throwing', () => {
  const t = tailTranscript(path.join(tmp, 'nope.jsonl'));
  assert.deepEqual(t, { exists: false, entries: [], error: 'not-found' });
});

test('sessionStats: small context high-water infers the 200k window', () => {
  const file = writeTranscript([assistant()]);
  const s = sessionStats(file);
  assert.equal(s.contextWindow, 200_000);
  assert.equal(s.version, '2.1.240');
  assert.equal(s.usageApprox, false);
});

test('sessionStats: context high-water beyond 190k proves the 1M window', () => {
  const file = writeTranscript([
    assistant({
      message: {
        model: 'claude-fable-5',
        usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 500_000, output_tokens: 1 },
        content: [{ type: 'text', text: 'big' }],
      },
    }),
    // A later smaller request must not shrink the inferred window.
    assistant(),
  ]);
  const s = sessionStats(file);
  assert.equal(s.contextWindow, 1_000_000);
  assert.equal(s.contextTokens, 115); // latest request, not the high-water
});

test('sessionStats: null for a missing path or file', () => {
  assert.equal(sessionStats(null), null);
  assert.equal(sessionStats(path.join(tmp, 'gone.jsonl')), null);
});

test('agentMeta: sibling .meta.json wins over the transcript', () => {
  const file = writeTranscript([
    { type: 'user', message: { content: 'delegation prompt text' } },
  ]);
  fs.writeFileSync(
    file.replace(/\.jsonl$/, '.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: 'Fix the flaky test', model: 'opus' })
  );
  assert.deepEqual(agentMeta(file), {
    description: 'Fix the flaky test',
    agentType: 'general-purpose',
    model: 'opus',
  });
});

test('agentMeta: falls back to the first user message when no .meta.json exists', () => {
  const file = writeTranscript([
    'garbage',
    { type: 'user', message: { content: 'Build the WAL archiving kit\nwith details' } },
  ]);
  const m = agentMeta(file);
  assert.equal(m.description, 'Build the WAL archiving kit');
  assert.equal(m.agentType, null);
});

test('agentMeta: missing transcript returns null (retry later, not cached)', () => {
  assert.equal(agentMeta(path.join(tmp, 'ghost.jsonl')), null);
});

test('user prompts are parsed as entries; meta/command/system noise is skipped', () => {
  const { sessionReplay } = require('../plugins/golden-eye/server/transcript');
  const file = writeTranscript([
    { type: 'user', timestamp: '2026-09-01T09:00:00Z', message: { content: 'plain string prompt' } },
    { type: 'user', timestamp: '2026-09-01T09:00:01Z', message: { content: [{ type: 'text', text: 'block prompt' }] } },
    { type: 'user', timestamp: '2026-09-01T09:00:02Z', isMeta: true, message: { content: [{ type: 'text', text: 'meta noise' }] } },
    { type: 'user', timestamp: '2026-09-01T09:00:03Z', message: { content: [{ type: 'text', text: '<command-name>/pm</command-name>' }] } },
    { type: 'user', timestamp: '2026-09-01T09:00:04Z', message: { content: [{ type: 'text', text: 'Caveat: The messages below were generated…' }] } },
    { type: 'user', timestamp: '2026-09-01T09:00:05Z', message: { content: [{ type: 'text', text: '<system-reminder>noise</system-reminder>' }] } },
  ]);
  const users = tailTranscript(file).entries.filter((e) => e.kind === 'user');
  assert.deepEqual(users.map((e) => e.text), ['plain string prompt', 'block prompt']);
  assert.ok(sessionReplay); // export exists
});

test('sessionReplay: only entries strictly older than the boundary; feed kinds only', () => {
  const { sessionReplay } = require('../plugins/golden-eye/server/transcript');
  const file = writeTranscript([
    { type: 'user', timestamp: '2026-09-01T09:00:00Z', message: { content: 'old prompt' } },
    assistant({ timestamp: '2026-09-01T09:00:01Z', message: { content: [
      { type: 'thinking', thinking: 'hidden' },
      { type: 'text', text: 'old answer' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ] } }),
    { type: 'user', timestamp: '2026-09-01T09:00:02Z', message: { content: [{ type: 'tool_result', content: 'out' }] } },
    { type: 'user', timestamp: '2026-09-01T11:00:00Z', message: { content: 'post-resume prompt (live-hooked)' } },
  ]);
  const replay = sessionReplay(file, '2026-09-01T10:00:00.000Z');
  assert.deepEqual(replay.map((e) => [e.kind, e.text ?? e.name]), [
    ['user', 'old prompt'],
    ['text', 'old answer'],
    ['tool', 'Bash'],
  ]); // thinking + tool_result excluded; post-boundary prompt excluded
});

test('sessionReplay: fresh session (no pre-boundary history) yields null', () => {
  const { sessionReplay } = require('../plugins/golden-eye/server/transcript');
  const file = writeTranscript([
    { type: 'user', timestamp: '2026-09-01T11:00:00Z', message: { content: 'first live prompt' } },
  ]);
  assert.equal(sessionReplay(file, '2026-09-01T10:00:00.000Z'), null);
  assert.equal(sessionReplay(path.join(tmp, 'missing.jsonl'), '2026-09-01T10:00:00.000Z'), null);
});

test('artifactsFromTranscript: only counts publishes inside an Artifact tool_result', () => {
  const url = 'https://claude.ai/code/artifact/aaa-111';
  const file = writeTranscript([
    // A real publish: Artifact tool_use, then its paired result.
    { type: 'assistant', timestamp: '2026-01-01T10:00:00Z', message: { content: [
      { type: 'tool_use', id: 'toolu_A', name: 'Artifact', input: { file_path: '/tmp/p.html', favicon: '🎙️', description: 'desc' } },
    ] } },
    { type: 'user', timestamp: '2026-01-01T10:00:02Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'toolu_A', content: `Published /tmp/p.html at ${url}\n\nLive subscription: armed` },
    ] } },
    // Decoys that must NOT register: the same sentence in a Bash result
    // (e.g. grepping another transcript) and in assistant prose.
    { type: 'assistant', timestamp: '2026-01-01T10:01:00Z', message: { content: [
      { type: 'tool_use', id: 'toolu_B', name: 'Bash', input: { command: 'grep artifact log' } },
    ] } },
    { type: 'user', timestamp: '2026-01-01T10:01:01Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'toolu_B', content: 'Published /other/x.html at https://claude.ai/code/artifact/bbb-222' },
    ] } },
    { type: 'assistant', timestamp: '2026-01-01T10:02:00Z', message: { content: [
      { type: 'text', text: 'Published /tmp/q.html at https://claude.ai/code/artifact/ccc-333 earlier.' },
    ] } },
  ]);

  const found = artifactsFromTranscript(file);
  assert.deepEqual(found.map((a) => a.id), ['aaa-111']);
  assert.equal(found[0].url, url);
  assert.equal(found[0].favicon, '🎙️');
  assert.equal(found[0].description, 'desc');
  assert.equal(found[0].path, '/tmp/p.html');
  assert.equal(found[0].publishes, 1);
  assert.equal(found[0].lastAt, '2026-01-01T10:00:02Z');
});

test('artifactsFromTranscript: redeploys of one id collapse, non-publish results ignored', () => {
  const file = writeTranscript([
    { type: 'assistant', timestamp: '2026-01-02T10:00:00Z', message: { content: [
      { type: 'tool_use', id: 'u1', name: 'Artifact', input: { file_path: '/tmp/p.html' } },
    ] } },
    { type: 'user', timestamp: '2026-01-02T10:00:01Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'u1', content: 'Published /tmp/p.html at https://claude.ai/code/artifact/dup-1' },
    ] } },
    { type: 'assistant', timestamp: '2026-01-02T11:00:00Z', message: { content: [
      { type: 'tool_use', id: 'u2', name: 'Artifact', input: { file_path: '/tmp/p.html' } },
    ] } },
    { type: 'user', timestamp: '2026-01-02T11:00:01Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'u2', content: 'Published /tmp/p.html at https://claude.ai/code/artifact/dup-1' },
    ] } },
    // A db write through the Artifact tool: no "Published … at <url>" line.
    { type: 'assistant', timestamp: '2026-01-02T12:00:00Z', message: { content: [
      { type: 'tool_use', id: 'u3', name: 'Artifact', input: { action: 'write_db', db_op: 'set' } },
    ] } },
    { type: 'user', timestamp: '2026-01-02T12:00:01Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'u3', content: '{"db_write":{"committed":true}}' },
    ] } },
  ]);

  const found = artifactsFromTranscript(file);
  assert.equal(found.length, 1);
  assert.equal(found[0].publishes, 2);
  assert.equal(found[0].firstAt, '2026-01-02T10:00:01Z');
  assert.equal(found[0].lastAt, '2026-01-02T11:00:01Z');
});

test('artifactsFromTranscript: missing file yields no artifacts', () => {
  assert.deepEqual(artifactsFromTranscript(path.join(tmp, 'nope.jsonl')), []);
});

test('tool entries carry their id; results carry forId and mark empty output', () => {
  const file = writeTranscript([
    { type: 'assistant', timestamp: '2026-02-01T10:00:00Z', message: { content: [
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'kubectl rollout status' } },
    ] } },
    { type: 'user', timestamp: '2026-02-01T10:00:30Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'deployment rolled out' },
    ] } },
    // A silent command: the result carries no text but still proves the call
    // finished, so the viewer must not show it as forever in-flight.
    { type: 'assistant', timestamp: '2026-02-01T10:01:00Z', message: { content: [
      { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'true' } },
    ] } },
    { type: 'user', timestamp: '2026-02-01T10:01:01Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'toolu_2', content: '' },
    ] } },
  ]);

  const { entries } = tailTranscript(file);
  const tools = entries.filter((e) => e.kind === 'tool');
  const results = entries.filter((e) => e.kind === 'result');
  assert.deepEqual(tools.map((t) => t.id), ['toolu_1', 'toolu_2']);
  assert.deepEqual(results.map((r) => r.forId), ['toolu_1', 'toolu_2']);
  assert.equal(results[0].empty, false);
  assert.equal(results[1].empty, true);
  assert.equal(results[1].text, '');
});
