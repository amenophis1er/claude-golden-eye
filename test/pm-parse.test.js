'use strict';

/**
 * /pm prompt parsing. Both shipped regressions live here as named tests:
 *  - "/pm off" re-engaging PM because `Arguments:` was matched case-sensitively
 *  - the plugin-namespaced "/claude-golden-eye:pm" form not matching at all
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePmPrompt } = require('../plugins/golden-eye-pm/hooks/lib/parse');

test('ordinary prompts are not /pm invocations', () => {
  assert.equal(parsePmPrompt('fix the login bug'), null);
  assert.equal(parsePmPrompt('what does /pm do?'), null); // not at start
  assert.equal(parsePmPrompt('/pmx something'), null); // word boundary
  assert.equal(parsePmPrompt(''), null);
  assert.equal(parsePmPrompt(undefined), null);
});

test('raw "/pm off" disengages — any case, trailing text ignored', () => {
  assert.deepEqual(parsePmPrompt('/pm off'), { action: 'off' });
  assert.deepEqual(parsePmPrompt('/pm OFF'), { action: 'off' });
  assert.deepEqual(parsePmPrompt('  /pm off please'), { action: 'off' });
});

test('raw "/pm on <mission>" engages with the mission text', () => {
  const p = parsePmPrompt('/pm on MISSION: ship the payments refactor');
  assert.deepEqual(p, { action: 'on', mission: 'MISSION: ship the payments refactor', subModel: null });
});

test('bare "/pm" and "/pm on" engage with an empty mission', () => {
  assert.deepEqual(parsePmPrompt('/pm'), { action: 'on', mission: '', subModel: null });
  assert.deepEqual(parsePmPrompt('/pm on'), { action: 'on', mission: '', subModel: null });
});

test('mission separators after "on" are trimmed', () => {
  assert.equal(parsePmPrompt('/pm on — ship it').mission, 'ship it');
  assert.equal(parsePmPrompt('/pm on: ship it').mission, 'ship it');
  assert.equal(parsePmPrompt('/pm on, ship it').mission, 'ship it');
});

test('regression: namespaced plugin command forms match', () => {
  assert.deepEqual(parsePmPrompt('/claude-golden-eye:pm off'), { action: 'off' });
  assert.deepEqual(parsePmPrompt('/golden-eye-pm:pm off'), { action: 'off' });
  const p = parsePmPrompt('/golden-eye-pm:pm on MISSION: x');
  assert.equal(p.action, 'on');
  assert.equal(p.mission, 'MISSION: x');
});

test('--sub model pin: every accepted spelling, lowercased, removed from mission', () => {
  for (const raw of [
    '/pm on --sub opus MISSION: x',
    '/pm on --sub=opus MISSION: x',
    '/pm on --sub-model opus MISSION: x',
    '/pm on --sub-model=opus MISSION: x',
    '/pm on sub-model: opus MISSION: x',
    '/pm on sub_model = opus MISSION: x',
  ]) {
    const p = parsePmPrompt(raw);
    assert.equal(p.subModel, 'opus', raw);
    assert.equal(p.mission, 'MISSION: x', raw);
  }
  assert.equal(parsePmPrompt('/pm on --sub OPUS m').subModel, 'opus');
});

test('marker path: expanded command text parses $ARGUMENTS', () => {
  const expanded =
    '[PM-MODE-COMMAND golden-eye]\nUser arguments: "on --sub opus MISSION: probe"\n\nfollow the charter…';
  const p = parsePmPrompt(expanded);
  assert.deepEqual(p, { action: 'on', mission: 'MISSION: probe', subModel: 'opus' });
});

test('regression: marker path matches `Arguments:` case-insensitively (off stays off)', () => {
  const expanded = '[PM-MODE-COMMAND golden-eye]\nArguments: "off"\n…';
  assert.deepEqual(parsePmPrompt(expanded), { action: 'off' });
});

test('regression: quotes later in the expanded skill body do not bleed into the mission', () => {
  const expanded =
    '[PM-MODE-COMMAND golden-eye]\nUser arguments: "on build a parser"\n\n' +
    'You are the PM until the user says "/pm off". Follow the charter…';
  assert.deepEqual(parsePmPrompt(expanded), { action: 'on', mission: 'build a parser', subModel: null });
});

test('quotes inside the args line itself survive', () => {
  const expanded = '[PM-MODE-COMMAND golden-eye]\nUser arguments: "on fix the "parser" module"\n…';
  assert.equal(parsePmPrompt(expanded).mission, 'fix the "parser" module');
});

test('regression: "on" prefix strips case-insensitively', () => {
  assert.equal(parsePmPrompt('/pm ON ship it').mission, 'ship it');
  assert.deepEqual(parsePmPrompt('/pm On'), { action: 'on', mission: '', subModel: null });
});

test('marker present but arguments unparseable ⇒ engage with empty mission, never mis-parse', () => {
  const p = parsePmPrompt('[PM-MODE-COMMAND golden-eye] no args line at all');
  assert.deepEqual(p, { action: 'on', mission: '', subModel: null });
});
