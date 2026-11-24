const pointSegmentDistance2 = (point, start, end) => {
  const dx = end.x - start.x, dy = end.y - start.y;
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length2));
  return (point.x - start.x - t * dx) ** 2 + (point.y - start.y - t * dy) ** 2;
};

// A witness on the hurtbox inside the finite attack capsule, in world coordinates.
export function capsuleBoxContact(start, end, box, radius) {
  let low = 0, high = 1;
  for (const axis of ['X', 'Y']) {
    const key = axis.toLowerCase(), delta = end[key] - start[key];
    if (Math.abs(delta) < 1e-12) {
      if (start[key] < box[`min${axis}`] || start[key] > box[`max${axis}`]) { high = -1; break; }
    } else {
      const a = (box[`min${axis}`] - start[key]) / delta, b = (box[`max${axis}`] - start[key]) / delta;
      low = Math.max(low, Math.min(a, b)); high = Math.min(high, Math.max(a, b));
    }
  }
  if (low <= high) return { x: start.x + low * (end.x - start.x), y: start.y + low * (end.y - start.y) };
  // Otherwise the closest pair uses a segment endpoint or a rectangle corner.
  const radius2 = radius * radius + 1e-9;
  for (const point of [start, end]) {
    const x = Math.max(box.minX, Math.min(box.maxX, point.x));
    const y = Math.max(box.minY, Math.min(box.maxY, point.y));
    if ((x - point.x) ** 2 + (y - point.y) ** 2 <= radius2) return { x, y };
  }
  for (const x of [box.minX, box.maxX]) for (const y of [box.minY, box.maxY]) {
    if (pointSegmentDistance2({ x, y }, start, end) <= radius2) return { x, y };
  }
  return null;
}

export function segmentHitsBox(start, end, box, radius) {
  return capsuleBoxContact(start, end, box, radius) !== null;
}

const cross = (a, b) => a.x * b.y - a.y * b.x;
const subtract = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
function segmentContact(a, b, c, d) {
  const ab = subtract(b, a), cd = subtract(d, c), ac = subtract(c, a), divisor = cross(ab, cd);
  if (Math.abs(divisor) > 1e-9) {
    const t = cross(ac, cd) / divisor, u = cross(ac, ab) / divisor;
    if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) {
      return { x: a.x + t * ab.x, y: a.y + t * ab.y };
    }
  } else {
    for (const point of [a, b]) if (pointSegmentDistance2(point, c, d) <= 1e-18) return point;
    for (const point of [c, d]) if (pointSegmentDistance2(point, a, b) <= 1e-18) return point;
  }
  return null;
}
function insidePolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) &&
      point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Return an actual outline intersection/containment point, not an AABB hit.
export function polygonContact(a, b) {
  const bounds = polygon => ({ minX: Math.min(...polygon.map(p => p.x)), maxX: Math.max(...polygon.map(p => p.x)),
    minY: Math.min(...polygon.map(p => p.y)), maxY: Math.max(...polygon.map(p => p.y)) });
  const aa = bounds(a), bb = bounds(b);
  if (aa.maxX < bb.minX || bb.maxX < aa.minX || aa.maxY < bb.minY || bb.maxY < aa.minY) return null;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    const contact = segmentContact(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length]);
    if (contact) return contact;
  }
  if (insidePolygon(a[0], b)) return a[0];
  if (insidePolygon(b[0], a)) return b[0];
  return null;
}
