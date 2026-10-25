// Pure view math for the map: zoom clamping, pan clamping and anchored zoom.
// Kept separate from app.js so it can be unit-tested in node without a canvas.

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 12;

export function clampZoom(value) {
  const z = Number(value);
  if (!Number.isFinite(z)) return MIN_ZOOM;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

/**
 * Keep the (already zoomed) map rect inside the viewport.
 * bounds: {left, right, top, bottom} of the map in screen coords with ox = oy = 0.
 * Returns {ox, oy}: the translation to apply so the map fills the viewport, or is
 * centred when it is smaller than the viewport in that axis.
 */
export function clampPan(bounds, viewport, ox, oy) {
  const mapW = bounds.right - bounds.left;
  const mapH = bounds.bottom - bounds.top;
  let x;
  let y;

  if (mapW >= viewport.width) {
    x = Math.min(-bounds.left, Math.max(viewport.width - bounds.right, ox));
  } else {
    x = (viewport.width - mapW) / 2 - bounds.left;
  }

  if (mapH >= viewport.height) {
    y = Math.min(-bounds.top, Math.max(viewport.height - bounds.bottom, oy));
  } else {
    y = (viewport.height - mapH) / 2 - bounds.top;
  }
  return { ox: x, oy: y };
}

/**
 * Change the zoom while keeping the point under `anchor` (screen coords) fixed.
 * project(lon, lat) = cx + (base - cx) * z + offset, so the base coordinate under the
 * anchor is recovered from the old zoom/offset and re-used for the new one.
 */
export function zoomAt({ zoom, ox, oy }, nextZoom, anchor, centre) {
  const z0 = clampZoom(zoom);
  const z1 = clampZoom(nextZoom);
  const ax = Number.isFinite(anchor?.x) ? anchor.x : centre.x;
  const ay = Number.isFinite(anchor?.y) ? anchor.y : centre.y;
  const bx = (ax - ox - centre.x) / z0 + centre.x;
  const by = (ay - oy - centre.y) / z0 + centre.y;
  return {
    zoom: z1,
    ox: ax - centre.x - (bx - centre.x) * z1,
    oy: ay - centre.y - (by - centre.y) * z1,
  };
}

/** Project a point with zoom applied (no pan). */
export function projectZoomed(point, centre, zoom) {
  return {
    x: centre.x + (point.x - centre.x) * zoom,
    y: centre.y + (point.y - centre.y) * zoom,
  };
}
