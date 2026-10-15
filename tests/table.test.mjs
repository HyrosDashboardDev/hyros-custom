import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortRows, nextSort, sortHeader } from '../src/ui/table.js';

const rows = [
  { name: 'b', cost: 10 },
  { name: 'a', cost: null },
  { name: 'c', cost: 30 },
  { name: null, cost: Number.NaN },
  { name: 'd', cost: 20 },
];

test('sortRows orders numbers both ways and keeps missing values last', () => {
  assert.deepEqual(sortRows(rows, { col: 'cost', dir: 'desc' }).map((r) => r.cost).slice(0, 3), [30, 20, 10]);
  assert.deepEqual(sortRows(rows, { col: 'cost', dir: 'asc' }).map((r) => r.cost).slice(0, 3), [10, 20, 30]);
  for (const dir of ['asc', 'desc']) {
    const tail = sortRows(rows, { col: 'cost', dir }).slice(3).map((r) => r.cost);
    assert.ok(tail.every((v) => v === null || Number.isNaN(v)), `missing last when ${dir}`);
  }
});

test('sortRows orders text and does not touch the input', () => {
  const copy = [...rows];
  assert.deepEqual(sortRows(rows, { col: 'name', dir: 'asc' }).map((r) => r.name), ['a', 'b', 'c', 'd', null]);
  assert.deepEqual(rows, copy);
});

test('nextSort flips the same column and starts a new one at firstDir', () => {
  assert.deepEqual(nextSort({ col: 'cost', dir: 'desc' }, 'cost'), { col: 'cost', dir: 'asc' });
  assert.deepEqual(nextSort({ col: 'cost', dir: 'asc' }, 'cost'), { col: 'cost', dir: 'desc' });
  assert.deepEqual(nextSort({ col: 'cost', dir: 'asc' }, 'name', 'asc'), { col: 'name', dir: 'asc' });
});

test('sortHeader marks the sorted column and escapes the label', () => {
  assert.equal(sortHeader({ col: 'cost', label: 'Cost', cls: 'hy' }, { col: 'cost', dir: 'asc' }),
    '<th class="sorted hy" data-col="cost">Cost<span class="arrow">▲</span></th>');
  assert.equal(sortHeader({ col: 'name', label: '<b>' }, { col: 'cost', dir: 'asc' }),
    '<th data-col="name">&lt;b&gt;<span class="arrow"></span></th>');
});
