const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isMixedDirectionLine,
  splitBidirectionalRuns,
} = require('../src/shared/latinText');

test('isMixedDirectionLine detects English and Dari on one line', () => {
  assert.equal(isMixedDirectionLine('I want to study medicine. من می‌خواهم'), true);
  assert.equal(isMixedDirectionLine('Only English here.'), false);
  assert.equal(isMixedDirectionLine('فقط دری'), false);
});

test('splitBidirectionalRuns isolates Latin and RTL segments', () => {
  const runs = splitBidirectionalRuns('Hello من world');
  assert.deepEqual(runs, [
    { dir: 'ltr', text: 'Hello ' },
    { dir: 'rtl', text: 'من ' },
    { dir: 'ltr', text: 'world' },
  ]);
});

test('splitBidirectionalRuns keeps single-direction lines intact', () => {
  assert.deepEqual(splitBidirectionalRuns('Hello world'), [{ dir: 'ltr', text: 'Hello world' }]);
  assert.deepEqual(splitBidirectionalRuns('سلام دنیا'), [{ dir: 'rtl', text: 'سلام دنیا' }]);
});
