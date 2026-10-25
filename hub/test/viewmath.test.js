import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_ZOOM, MIN_ZOOM, clampPan, clampZoom, zoomAt } from '../public/viewmath.js';

const viewport = { width: 1000, height: 500 };
// a map that exactly fills the viewport at zoom 1
const bounds = { left: 0, right: 1000, top: 0, bottom: 500 };
const centre = { x: 500, y: 250 };

test('clampZoom keeps the zoom in range', () => {
  assert.equal(clampZoom(0.2), MIN_ZOOM);
  assert.equal(clampZoom(50), MAX_ZOOM);
  assert.equal(clampZoom(3), 3);
  assert.equal(clampZoom('x'), MIN_ZOOM);
});

test('clampPan centres a map smaller than the viewport', () => {
  const small = { left: 100, right: 900, top: 100, bottom: 400 }; // 800x300 at zoom 1
  const { ox, oy } = clampPan(small, viewport, 500, 500);
  assert.equal(small.left + ox, (viewport.width - 800) / 2, 'x centred');
  assert.equal(small.top + oy, (viewport.height - 300) / 2, 'y centred');
  assert.deepEqual({ ox, oy }, { ox: 0, oy: 0 });
});

test('clampPan stops the map edges leaving the viewport', () => {
  const zoomed = { left: -1000, right: 3000, top: -800, bottom: 1800 };
  assert.deepEqual(clampPan(zoomed, viewport, -9999, 9999), {
    ox: viewport.width - zoomed.right,
    oy: -zoomed.top,
  });
  // inside the allowed range nothing moves
  assert.deepEqual(clampPan(zoomed, viewport, -500, 200), { ox: -500, oy: 200 });
});

test('zoomAt keeps the anchor point pinned', () => {
  const anchor = { x: 200, y: 120 };
  const before = { zoom: 1, ox: 0, oy: 0 };
  // base coordinate under the anchor at zoom 1
  const baseX = (anchor.x - before.ox - centre.x) / before.zoom + centre.x;
  const baseY = (anchor.y - before.oy - centre.y) / before.zoom + centre.y;

  const after = zoomAt(before, 4, anchor, centre);
  const screenX = centre.x + (baseX - centre.x) * after.zoom + after.ox;
  const screenY = centre.y + (baseY - centre.y) * after.zoom + after.oy;
  assert.ok(Math.abs(screenX - anchor.x) < 1e-9, `x pinned (${screenX})`);
  assert.ok(Math.abs(screenY - anchor.y) < 1e-9, `y pinned (${screenY})`);
});

test('zoomAt clamps the zoom range', () => {
  const out = zoomAt({ zoom: 1, ox: 0, oy: 0 }, 999, centre, centre);
  assert.equal(out.zoom, MAX_ZOOM);
});
