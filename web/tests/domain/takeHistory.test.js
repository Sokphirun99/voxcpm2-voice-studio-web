import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SESSION_TAKES,
  findActiveTake,
  pushTakeHistory,
  removeTakeFromHistory,
} from '../../src/domain/takeHistory.js';

const take = (id, audioDurationSeconds = 1) => ({ id, audioDurationSeconds });

test('pushTakeHistory appends chronologically, replaces duplicate IDs, and evicts the oldest take beyond the cap', () => {
  assert.deepEqual(pushTakeHistory([], take('a')).map(item => item.id), ['a']);

  const ordered = pushTakeHistory(pushTakeHistory([], take('a')), take('b'));
  assert.deepEqual(ordered.map(item => item.id), ['a', 'b']);

  const duplicate = pushTakeHistory([take('a'), take('b'), take('c')], take('b', 9));
  assert.deepEqual(duplicate.map(item => item.id), ['a', 'c', 'b']);
  assert.equal(duplicate.at(-1).audioDurationSeconds, 9);

  let capped = [];
  for (let index = 1; index <= MAX_SESSION_TAKES + 2; index++) {
    capped = pushTakeHistory(capped, take(`take-${index}`, index));
  }
  assert.equal(capped.length, MAX_SESSION_TAKES);
  assert.equal(capped[0].id, 'take-3');
  assert.equal(capped.at(-1).id, `take-${MAX_SESSION_TAKES + 2}`);
});

test('pushTakeHistory ignores malformed recordings and never mutates the input list', () => {
  const source = [take('a'), take('b')];
  const snapshot = [...source];

  assert.deepEqual(pushTakeHistory(source, null), source);
  assert.deepEqual(pushTakeHistory(source, { audioDurationSeconds: 2 }), source);
  assert.deepEqual(source, snapshot);

  assert.deepEqual(pushTakeHistory('not-a-list', take('a')).map(item => item.id), ['a']);
});

test('removeTakeFromHistory removes by ID without mutating input and leaves unknown IDs intact', () => {
  const source = [take('a'), take('b'), take('c')];
  const remaining = removeTakeFromHistory(source, 'b');

  assert.deepEqual(remaining.map(item => item.id), ['a', 'c']);
  assert.deepEqual(source.map(item => item.id), ['a', 'b', 'c']);
  assert.deepEqual(removeTakeFromHistory(source, 'missing').map(item => item.id), ['a', 'b', 'c']);
});

test('findActiveTake selects the requested take and falls back to the newest take after deletion', () => {
  const takes = [take('a'), take('b'), take('c')];

  assert.equal(findActiveTake(takes, 'b'), takes[1]);
  assert.equal(findActiveTake(takes, 'missing'), takes[2]);
  assert.equal(findActiveTake([], 'a'), null);

  const afterDelete = removeTakeFromHistory(takes, 'c');
  assert.deepEqual(afterDelete.map(item => item.id), ['a', 'b']);
  assert.equal(findActiveTake(afterDelete, 'c').id, 'b');
  assert.equal(findActiveTake(removeTakeFromHistory(takes, 'a'), 'a').id, 'c');
  assert.equal(findActiveTake(removeTakeFromHistory([take('only')], 'only'), 'only'), null);
});
