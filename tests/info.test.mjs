import { test } from 'node:test';
import assert from 'node:assert/strict';
import { infoButton, placeBubble } from '../src/ui/info.js';

const VIEW = { width: 1440, height: 900 };
const SIZE = { width: 330, height: 98 };
const at = (left, top) => ({ left, top, bottom: top + 22, width: 22 });

test('the info button carries its sentence escaped, and a name for a screen reader', () => {
  const html = infoButton('Sales & "leads" <b>only</b>.', 'What this covers');
  assert.match(html, /^<button type="button" class="info-btn" data-info="Sales &amp; &quot;leads&quot; &lt;b&gt;only&lt;\/b&gt;\." aria-label="What this covers" aria-expanded="false">/);
  assert.equal(html.includes('<b>'), false);
  assert.match(infoButton('x'), /aria-label="About these numbers"/);
});

test('the bubble sits under its button, centered on it', () => {
  const p = placeBubble({ anchor: at(600, 100), size: SIZE, view: VIEW });
  assert.equal(p.up, false);
  assert.equal(p.top, 100 + 22 + 9);
  assert.equal(p.left, 611 - 165);
  assert.equal(p.caret, 165, 'the pointer is in the middle of the bubble, on the button');
});

test('at an edge the bubble slides in and the pointer stays on the button', () => {
  const left = placeBubble({ anchor: at(20, 100), size: SIZE, view: VIEW });
  assert.equal(left.left, 10);
  assert.equal(left.caret, 31 - 10);
  const right = placeBubble({ anchor: at(1400, 100), size: SIZE, view: VIEW });
  assert.equal(right.left, 1440 - 10 - 330);
  assert.equal(right.caret, 1411 - right.left);
  const corner = placeBubble({ anchor: at(0, 100), size: SIZE, view: VIEW });
  assert.equal(corner.caret, 16, 'never on the rounded corner');
});

test('a bubble wider than a phone still starts at the edge of the window', () => {
  const p = placeBubble({ anchor: at(120, 290), size: { width: 400, height: 98 }, view: { width: 390, height: 760 } });
  assert.equal(p.left, 10);
});

test('with no room under the button the bubble goes above it, when there is room there', () => {
  const up = placeBubble({ anchor: at(600, 840), size: SIZE, view: VIEW });
  assert.equal(up.up, true);
  assert.equal(up.top, 840 - 9 - 98);
  const tight = placeBubble({ anchor: at(600, 60), size: SIZE, view: { width: 1440, height: 150 } });
  assert.equal(tight.up, false, 'no room above either: it stays under');
});
