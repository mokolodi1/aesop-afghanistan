const test = require('node:test');
const assert = require('node:assert/strict');

const { countWords } = require('../src/shared/countWords');

test('countWords returns 0 for empty or whitespace-only text', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords('   \n\t  '), 0);
  assert.equal(countWords(null), 0);
});

test('countWords counts words separated by whitespace', () => {
  assert.equal(countWords('one'), 1);
  assert.equal(countWords('one two three'), 3);
  assert.equal(countWords('  one   two\nthree  '), 3);
});
