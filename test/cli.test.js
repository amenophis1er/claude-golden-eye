'use strict';

/**
 * Installer CLI tests — the pure decision helpers only; the imperative install
 * flow shells out to `claude` and is exercised by hand/release smoke tests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCliArgs, decideMarketplaceAction } = require('../bin/cli');

test('parseCliArgs: command, boolean flags, negation, -y alias', () => {
  const r = parseCliArgs(['init', '--yes', '--pm', '--no-composer']);
  assert.equal(r.command, 'init');
  assert.deepEqual(r.flags, { yes: true, pm: true, composer: false });
  assert.deepEqual(r.errors, []);

  assert.deepEqual(parseCliArgs(['init', '-y']).flags, { yes: true });
  // Unset flags stay undefined so init can tell "not chosen" from "declined".
  assert.equal(parseCliArgs(['init']).flags.pm, undefined);
});

test('parseCliArgs: rejects unknown flags and extra commands', () => {
  assert.match(parseCliArgs(['init', '--frobnicate']).errors[0], /unknown flag/);
  assert.match(parseCliArgs(['init', 'extra']).errors[0], /unexpected argument/);
});

test('decideMarketplaceAction: add when unknown, update when same path, repoint when moved', () => {
  const app = '/home/u/.golden-eye/app';
  assert.equal(decideMarketplaceAction(null, app), 'add');
  assert.equal(decideMarketplaceAction({}, app), 'add');
  assert.equal(decideMarketplaceAction({ 'claude-golden-eye': { installLocation: app } }, app), 'update');
  assert.equal(
    decideMarketplaceAction({ 'claude-golden-eye': { installLocation: '/old/npm/root' } }, app),
    'repoint'
  );
});
