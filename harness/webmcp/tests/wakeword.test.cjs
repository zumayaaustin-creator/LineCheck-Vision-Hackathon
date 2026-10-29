/**
 * Wake-word phrase matching tests.
 *
 * The recogniser itself needs a microphone and a browser, so the one piece that can be
 * verified deterministically - does this transcript contain our wake phrase - is a pure
 * exported function and tested here.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { matchWakePhrase, DEFAULT_PHRASES } = require('../.testdist/wakeword.js');

test('matches the exact phrase', () => {
  assert.equal(matchWakePhrase('line check'), 'line check');
});

test('matches with the wake prefix', () => {
  assert.equal(matchWakePhrase('hey line check'), 'hey line check');
});

test('longest phrase wins (no double count)', () => {
  assert.equal(matchWakePhrase('hey line check, what is in the pan'), 'hey line check');
});

test('is case insensitive', () => {
  assert.equal(matchWakePhrase('LINE CHECK'), 'line check');
});

test('tolerates punctuation and extra spacing', () => {
  assert.equal(matchWakePhrase('  Line   check!!  '), 'line check');
});

test('does not match a substring of another word', () => {
  assert.equal(matchWakePhrase('deadline checkered'), null);
});

test('does not match unrelated kitchen speech', () => {
  assert.equal(matchWakePhrase('log two pounds of salmon trim'), null);
  assert.equal(matchWakePhrase('tare the scale'), null);
});

test('empty and garbage input is safe', () => {
  assert.equal(matchWakePhrase(''), null);
  assert.equal(matchWakePhrase('   '), null);
  assert.equal(matchWakePhrase(null), null);
  assert.equal(matchWakePhrase(undefined), null);
});

test('accepts a custom phrase list', () => {
  assert.equal(matchWakePhrase('okay linecheck go', ['linecheck']), 'linecheck');
  assert.equal(matchWakePhrase('line check', ['linecheck']), null);
});

test('default phrases are exposed and include both forms', () => {
  assert.ok(DEFAULT_PHRASES.includes('line check'));
  assert.ok(DEFAULT_PHRASES.includes('hey line check'));
});
