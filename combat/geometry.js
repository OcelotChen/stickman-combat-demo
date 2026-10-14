import { LIMITS, fail, isRecord, round6 } from './rules.js';

const EPS = 1e-10;
const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];
const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSegment = (a, b, p) => Math.abs(cross(a, b, p)) <= EPS &&
  p[0] >= Math.min(a[0], b[0]) - EPS && p[0] <= Math.max(a[0], b[0]) + EPS &&
  p[1] >= Math.min(a[1], b[1]) - EPS && p[1] <= Math.max(a[1], b[1]) + EPS;

function intersects(a, b, c, d) {
  const abC = cross(a, b, c), abD = cross(a, b, d);
  const cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (((abC > EPS && abD < -EPS) || (abC < -EPS && abD > EPS)) &&
      ((cdA > EPS && cdB < -EPS) || (cdA < -EPS && cdB > EPS))) return true;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

function validateSimplePolygon(points, path) {
  const n = points.length - 1;
  for (let i = 0; i < n; i++) {
    const a = points[(i + n - 1) % n], b = points[i], c = points[(i + 1) % n];
    if (Math.abs(cross(a, b, c)) <= EPS &&
        (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0) {
      fail('SELF_INTERSECTION', '轮廓不能折返重叠。', path);
    }
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (intersects(points[i], points[i + 1], points[j], points[j + 1])) {
        fail('SELF_INTERSECTION', '闭合轮廓不能自交、相切或重叠。', path);
      }
    }
  }
}

function boundsOf(points) {
  const bounds = { minX: 1, minY: 1, maxX: 0, maxY: 0 };
  for (const [x, y] of points) {
    bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
  }
  return bounds;
}

function polygonMetrics(points) {
  let twiceArea = 0, cx = 0, cy = 0;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1], [x2, y2] = points[i];
    const term = x1 * y2 - x2 * y1;
    twiceArea += term; cx += (x1 + x2) * term; cy += (y1 + y2) * term;
  }
  const area = Math.abs(twiceArea) / 2;
  if (area < LIMITS.minArea || area > LIMITS.maxArea) {
    fail('AREA_LIMIT', `闭合面积须在 ${LIMITS.minArea}–${LIMITS.maxArea} 之间。`, 'drawing.strokes');
  }
  return { area: round6(area), centroid: { x: round6(cx / (3 * twiceArea)), y: round6(cy / (3 * twiceArea)) } };
}

function insidePolygon(point, polygon) {
  let inside = false;
  for (let i = 1; i < polygon.length; i++) {
    const a = polygon[i - 1], b = polygon[i];
    if (onSegment(a, b, point)) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
        point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

// Split a decorative segment at every boundary intersection. Testing every interval
// also rejects segments that leave and re-enter a concave outline between valid endpoints.
function segmentInside(a, b, polygon) {
  if (!insidePolygon(a, polygon) || !insidePolygon(b, polygon)) return false;
  const dx = b[0] - a[0], dy = b[1] - a[1], cuts = [0, 1];
  for (let i = 1; i < polygon.length; i++) {
    const c = polygon[i - 1], d = polygon[i];
    const ex = d[0] - c[0], ey = d[1] - c[1], denominator = dx * ey - dy * ex;
    if (Math.abs(denominator) <= EPS) continue;
    const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / denominator;
    const u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / denominator;
    if (t > 0 && t < 1 && u >= -EPS && u <= 1 + EPS) cuts.push(t);
  }
  cuts.sort((x, y) => x - y);
  for (let i = 1; i < cuts.length; i++) {
    const t = (cuts[i - 1] + cuts[i]) / 2;
    if (!insidePolygon([a[0] + t * dx, a[1] + t * dy], polygon)) return false;
  }
  return true;
}

export function analyzeDrawing(drawing) {
  if (!isRecord(drawing) || drawing.coordinateSpace !== 'normalized-0-to-1') {
    fail('COORDINATE_SPACE', '需要 normalized-0-to-1 正方形坐标。', 'drawing.coordinateSpace');
  }
  const strokes = drawing.strokes;
  if (!Array.isArray(strokes) || strokes.length === 0 || strokes.length > LIMITS.maxStrokes) {
    fail('STROKE_LIMIT', `需要 1–${LIMITS.maxStrokes} 笔线条。`, 'drawing.strokes');
  }
  let pointCount = 0, pathLength = 0;
  const outlines = [];
  for (let s = 0; s < strokes.length; s++) {
    const stroke = strokes[s], path = `drawing.strokes[${s}]`;
    if (!Array.isArray(stroke) || stroke.length < 2 || stroke.length > LIMITS.maxPointsPerStroke) {
      fail('POINT_LIMIT', `每笔需要 2–${LIMITS.maxPointsPerStroke} 个点。`, path);
    }
    pointCount += stroke.length;
    if (pointCount > LIMITS.maxTotalPoints) fail('POINT_LIMIT', '总点数超过 1024。', path);
    for (let p = 0; p < stroke.length; p++) {
      const point = stroke[p];
      if (!Array.isArray(point) || point.length !== 2 ||
          !point.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) {
        fail('INVALID_POINT', '点必须是两个 0–1 之间的有限数值。', `${path}[${p}]`);
      }
      if (p > 0) {
        const length = distance(stroke[p - 1], point);
        if (length <= 1e-6) fail('DEGENERATE_SEGMENT', '相邻点重复或线段过短。', `${path}[${p}]`);
        pathLength += length;
      }
    }
    if (samePoint(stroke[0], stroke.at(-1))) {
      if (stroke.length < 4) fail('INVALID_OUTLINE', '闭合轮廓至少需要三个不同顶点。', path);
      validateSimplePolygon(stroke, path);
      outlines.push(stroke);
    }
  }
  if (pathLength > LIMITS.maxPathLength) fail('PATH_LIMIT', '线条总长度超过 16。', 'drawing.strokes');
  if (outlines.length !== 1) {
    fail('OUTLINE_COUNT', '第一周要求恰好一个闭合外轮廓；孔洞与多个实体待确认。', 'drawing.strokes');
  }
  const outline = outlines[0], bounds = boundsOf(outline);
  const span = round6(Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY));
  if (span < LIMITS.minSpan) fail('SIZE_LIMIT', '轮廓尺寸过小。', 'drawing.strokes');
  const { area, centroid } = polygonMetrics(outline);
  for (let s = 0; s < strokes.length; s++) {
    if (strokes[s] === outline) continue;
    for (let p = 1; p < strokes[s].length; p++) {
      if (!segmentInside(strokes[s][p - 1], strokes[s][p], outline)) {
        fail('OUTSIDE_OUTLINE', '第一周的开口装饰线须位于外轮廓内或边界上。', `drawing.strokes[${s}]`);
      }
    }
  }
  return { pathLength: round6(pathLength), bounds, area, centroid, span, strokeCount: strokes.length, pointCount };
}
