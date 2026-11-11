import { test } from 'node:test';
import assert from 'node:assert/strict';
import { railGeometry, scrollForPoint, scrollPerPixel, columnsInView } from '../src/ui/rail.js';

const near = (a, b) => Math.abs(a - b) < 1e-9;

test('a table that fits has no rail', () => {
  assert.equal(railGeometry({ clientWidth: 1000, scrollWidth: 1000, scrollLeft: 0 }), null);
  assert.equal(railGeometry({ clientWidth: 1000, scrollWidth: 1001, scrollLeft: 0 }), null, 'a rounding pixel is not an overflow');
  assert.ok(railGeometry({ clientWidth: 1000, scrollWidth: 1002, scrollLeft: 0 }));
});

test('the bar is as wide as the share on screen and travels the rest of the track', () => {
  const table = { clientWidth: 1000, scrollWidth: 2000 };
  assert.deepEqual(railGeometry({ ...table, scrollLeft: 0 }), { size: 0.5, left: 0, max: 1000, progress: 0 });
  assert.equal(railGeometry({ ...table, scrollLeft: 500 }).left, 0.25);
  const end = railGeometry({ ...table, scrollLeft: 1000 });
  assert.equal(end.progress, 1);
  assert.ok(near(end.left + end.size, 1), 'at the end the bar touches the end of the track');
  assert.equal(railGeometry({ ...table, scrollLeft: -50 }).progress, 0);
  assert.equal(railGeometry({ ...table, scrollLeft: 5000 }).progress, 1);
});

test('a very wide table keeps a bar that can still be grabbed, and it still ends on the track', () => {
  const table = { clientWidth: 100, scrollWidth: 10000 };
  assert.equal(railGeometry({ ...table, scrollLeft: 0 }).size, 0.06);
  const end = railGeometry({ ...table, scrollLeft: 9900 });
  assert.ok(near(end.left + end.size, 1));
});

test('a press on the track puts the middle of the bar under the pointer', () => {
  const table = { trackWidth: 1000, clientWidth: 1000, scrollWidth: 2000 };
  assert.equal(scrollForPoint({ ...table, x: 500 }), 500);
  assert.equal(scrollForPoint({ ...table, x: 0 }), 0);
  assert.equal(scrollForPoint({ ...table, x: 1000 }), 1000);
  assert.equal(scrollForPoint({ x: 400, trackWidth: 1000, clientWidth: 1000, scrollWidth: 1000 }), 0, 'nothing to scroll');
  assert.equal(scrollForPoint({ x: 400, trackWidth: 0, clientWidth: 1000, scrollWidth: 2000 }), 0, 'a track that is not laid out yet');
});

test('dragging the bar from one end of the track to the other scrolls the whole table', () => {
  for (const table of [{ clientWidth: 1000, scrollWidth: 2000 }, { clientWidth: 100, scrollWidth: 10000 }, { clientWidth: 1376, scrollWidth: 1715 }]) {
    const trackWidth = 1200;
    const geo = railGeometry({ ...table, scrollLeft: 0 });
    const travel = trackWidth * (1 - geo.size);
    assert.ok(near(scrollPerPixel({ ...table, trackWidth }) * travel, geo.max));
  }
  assert.equal(scrollPerPixel({ trackWidth: 1200, clientWidth: 1000, scrollWidth: 1000 }), 0);
});

test('a column counts when it is whole on screen, and the frozen first column always does', () => {
  const first = { left: 0, right: 200 };
  const at = (shift) => [first, ...[0, 1, 2, 3].map((i) => ({ left: 200 + i * 100 - shift, right: 300 + i * 100 - shift }))];
  assert.equal(columnsInView(at(0), { left: 0, right: 450 }), 3, 'the column cut by the right edge does not count');
  assert.equal(columnsInView(at(0), { left: 0, right: 600 }), 5);
  assert.equal(columnsInView(at(150), { left: 0, right: 450 }), 3, 'a column sliding under the frozen one does not count');
  assert.equal(columnsInView(at(100), { left: 0, right: 450 }), 3, 'a column fully under the frozen one does not count');
  assert.equal(columnsInView([], { left: 0, right: 450 }), 0);
});
