import { describe, expect, it } from 'vitest';
import { measureBounds, type Bounds } from '../src/measurement';

const bounds = (x: number, y: number, width = 100, height = 100): Bounds => ({ x, y, width, height });

describe('measureBounds', () => {
  it('measures the facing horizontal edges with the shared vertical midpoint', () => {
    expect(measureBounds(bounds(0, 0), bounds(140, 0))).toEqual([
      { axis: 'x', start: { x: 100, y: 50 }, end: { x: 140, y: 50 }, value: 40 },
    ]);
  });

  it('measures both nearest-edge gaps for diagonal separation', () => {
    expect(measureBounds(bounds(0, 0), bounds(130, 160))).toEqual([
      { axis: 'x', start: { x: 100, y: 130 }, end: { x: 130, y: 130 }, value: 30 },
      { axis: 'y', start: { x: 115, y: 100 }, end: { x: 115, y: 160 }, value: 60 },
    ]);
  });

  it('shows both opposing inset distances for containment', () => {
    expect(measureBounds(bounds(0, 0), bounds(20, 30, 50, 60))).toEqual([
      { axis: 'x', start: { x: 0, y: 60 }, end: { x: 20, y: 60 }, value: 20 },
      { axis: 'x', start: { x: 70, y: 60 }, end: { x: 100, y: 60 }, value: 30 },
      { axis: 'y', start: { x: 45, y: 0 }, end: { x: 45, y: 30 }, value: 30 },
      { axis: 'y', start: { x: 45, y: 90 }, end: { x: 45, y: 100 }, value: 10 },
    ]);
  });

  it('omits equal and numerically near-equal edges', () => {
    expect(measureBounds(bounds(0, 0), bounds(0, 0))).toEqual([]);
    expect(measureBounds(bounds(0, 0), bounds(0.0000001, -0.0000001))).toEqual([]);
  });

  it('shows corresponding outside-edge offsets for partial overlap', () => {
    expect(measureBounds(bounds(0, 0), bounds(60, 40))).toEqual([
      { axis: 'x', start: { x: 0, y: 70 }, end: { x: 60, y: 70 }, value: 60 },
      { axis: 'x', start: { x: 100, y: 70 }, end: { x: 160, y: 70 }, value: 60 },
      { axis: 'y', start: { x: 80, y: 0 }, end: { x: 80, y: 40 }, value: 40 },
      { axis: 'y', start: { x: 80, y: 100 }, end: { x: 80, y: 140 }, value: 40 },
    ]);
  });

  it('preserves fractional world distances without rounding', () => {
    const lines = measureBounds(bounds(-10.25, -3.5, 5.5, 7), bounds(-1.125, -3.5, 2, 7));
    expect(lines).toEqual([
      { axis: 'x', start: { x: -4.75, y: 0 }, end: { x: -1.125, y: 0 }, value: 3.625 },
    ]);
  });

  it('omits zero gaps when edges touch', () => {
    expect(measureBounds(bounds(0, 0), bounds(100, 0))).toEqual([]);
    expect(measureBounds(bounds(0, 0), bounds(100.0000001, 0))).toEqual([]);
  });

  it('is symmetric when the hovered and selected bounds swap', () => {
    for (const target of [bounds(130, -150), bounds(20, 30, 50, 60), bounds(-50, 25)]) {
      expect(measureBounds(bounds(0, 0), target)).toEqual(measureBounds(target, bounds(0, 0)));
    }
  });

  it('normalizes negative dimensions and rejects non-finite coordinates', () => {
    expect(measureBounds(bounds(100, 100, -100, -100), bounds(140, 0)))
      .toEqual(measureBounds(bounds(0, 0), bounds(140, 0)));
    expect(measureBounds(bounds(NaN, 0), bounds(0, 0))).toEqual([]);
  });
});
