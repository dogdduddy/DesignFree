export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MeasurementLine {
  axis: 'x' | 'y';
  start: { x: number; y: number };
  end: { x: number; y: number };
  value: number;
}

// World-space tolerance: avoid labels and strokes for floating-point edge noise.
const EPSILON = 1e-6;
type Interval = readonly [number, number];

function interval(start: number, size: number): Interval {
  return [Math.min(start, start + size), Math.max(start, start + size)];
}

function crossCoordinate(a: Interval, b: Interval): number {
  const low = Math.max(a[0], b[0]);
  const high = Math.min(a[1], b[1]);
  // Shared projection midpoint; for disjoint projections, facing-edge midpoint.
  return (low + high) / 2;
}

function axisLines(
  axis: MeasurementLine['axis'],
  source: Interval,
  target: Interval,
  cross: number,
): MeasurementLine[] {
  let pairs: [number, number][];
  if (source[1] < target[0] - EPSILON) {
    pairs = [[source[1], target[0]]];
  } else if (target[1] < source[0] - EPSILON) {
    pairs = [[target[1], source[0]]];
  } else {
    // Touching intervals have a zero nearest-edge gap, not two exterior offsets.
    if (Math.abs(source[1] - target[0]) <= EPSILON || Math.abs(target[1] - source[0]) <= EPSILON) {
      return [];
    }
    // Containment gives opposing insets. Partial overlap gives the two offsets
    // of corresponding outside edges; both remain unsigned under argument swap.
    pairs = [[source[0], target[0]], [source[1], target[1]]];
  }
  return pairs.flatMap(([a, b]) => {
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    const value = end - start;
    if (value <= EPSILON) return [];
    return [{
      axis,
      start: axis === 'x' ? { x: start, y: cross } : { x: cross, y: start },
      end: axis === 'x' ? { x: end, y: cross } : { x: cross, y: end },
      value,
    }];
  });
}

/** Measure world AABBs; callers convert rotated objects to world AABBs first.
 * Horizontal lines precede vertical lines; zero/near-zero distances are omitted.
 */
export function measureBounds(source: Bounds, target: Bounds): MeasurementLine[] {
  if (![source.x, source.y, source.width, source.height, target.x, target.y, target.width, target.height].every(Number.isFinite)) {
    return [];
  }
  const sx = interval(source.x, source.width);
  const sy = interval(source.y, source.height);
  const tx = interval(target.x, target.width);
  const ty = interval(target.y, target.height);
  return [
    ...axisLines('x', sx, tx, crossCoordinate(sy, ty)),
    ...axisLines('y', sy, ty, crossCoordinate(sx, tx)),
  ];
}
