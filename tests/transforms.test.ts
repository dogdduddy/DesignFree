import { describe, it, expect } from "vitest";
import {
  createNode,
  getWorldTransform,
  transformPoint,
  multiplyMatrices as mul,
  DocumentHistory,
  groupNodes,
  parseDocument,
  serializeDocument,
  type SceneDocument,
} from "../src/core";
import {
  handles,
  transformFrame,
  resizeBox,
  resizeSelection,
  rotateSelection,
  rotationDelta,
  frameRotation,
} from "../src/transforms";
function fixture(): SceneDocument {
  return {
    schemaVersion: 1,
    id: "d",
    name: "transforms",
    rootId: "p",
    assets: {},
    nodes: {
      p: createNode("page", null, { id: "p", children: ["f", "c"] }),
      f: createNode("frame", "p", {
        id: "f",
        children: ["a", "b"],
        transform: [0.8, 0.6, 0.3, 1.2, 100, 80],
      }),
      a: createNode("rectangle", "f", {
        id: "a",
        width: 80,
        height: 40,
        transform: [1, 0.2, 0.3, 1, 20, 30],
      }),
      b: createNode("rectangle", "f", {
        id: "b",
        width: 50,
        height: 30,
        transform: [1, 0, 0, 1, 150, 90],
      }),
      c: createNode("ellipse", "p", {
        id: "c",
        width: 40,
        height: 20,
        transform: [1, 0, 0, 1, 500, 300],
      }),
    },
  };
}
const close = (a: number[], b: number[]) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 7));
const xy = (p: { x: number; y: number }) => [p.x, p.y];
describe("selection transforms", () => {
  for (const handle of handles)
    it(`${handle.key} preserves opposing anchor in affine axes`, () => {
      const d = fixture(),
        f = transformFrame(d, ["a"])!,
        q = {
          x:
            handle.x * f.width +
            (handle.x === 0.5 ? 0 : handle.x === 0 ? -20 : 20),
          y:
            handle.y * f.height +
            (handle.y === 0.5 ? 0 : handle.y === 0 ? -10 : 10),
        };
      const box = resizeBox(f, handle, q),
        r = resizeSelection(d, f, box),
        n = r.nodes.a;
      const ax = handle.x === 0.5 ? 0.5 : 1 - handle.x,
        ay = handle.y === 0.5 ? 0.5 : 1 - handle.y;
      close(
        xy(
          transformPoint(getWorldTransform(r, "a"), {
            x: n.width * ax,
            y: n.height * ay,
          }),
        ),
        xy(transformPoint(f.basis, { x: f.width * ax, y: f.height * ay })),
      );
      expect(d.nodes.a.width).toBe(80);
    });
  it("Shift maintains ratio for all handles and Alt preserves center", () => {
    const d = fixture(),
      f = transformFrame(d, ["a"])!;
    for (const h of handles) {
      const b = resizeBox(
          f,
          h,
          { x: h.x * 80 + 25, y: h.y * 40 + 17 },
          true,
          true,
        ),
        r = resizeSelection(d, f, b);
      expect(b.width / b.height).toBeCloseTo(2, 8);
      close(
        xy(
          transformPoint(getWorldTransform(r, "a"), {
            x: b.width / 2,
            y: b.height / 2,
          }),
        ),
        xy(transformPoint(f.basis, { x: 40, y: 20 })),
      );
    }
  });
  it("side handles preserve an untouched axis below the minimum", () => {
    const d = fixture();
    d.nodes.a.height = 1;
    const f = transformFrame(d, ["a"])!;
    expect(resizeBox(f, handles[3], { x: 150, y: 0.5 }).height).toBe(1);
    d.nodes.a.width = 1;
    d.nodes.a.height = 100;
    expect(
      resizeBox(transformFrame(d, ["a"])!, handles[5], { x: 0.5, y: 150 })
        .width,
    ).toBe(1);
  });
  it("clamps crossing and extreme shrinking without reflection", () => {
    const f = transformFrame(fixture(), ["a"])!;
    for (const h of handles) {
      const b = resizeBox(f, h, {
        x: h.x === 0 ? 1000 : -1000,
        y: h.y === 0 ? 1000 : -1000,
      });
      expect(b.width).toBeGreaterThanOrEqual(8);
      expect(b.height).toBeGreaterThanOrEqual(8);
    }
  });
  it("multi mixed parents scales exact world corners, deduplicates descendants and skips locks", () => {
    const d = fixture(),
      f = transformFrame(d, ["f", "a", "c"])!;
    expect(f.ids).toEqual(["f", "c"]);
    const b = { x: -10, y: -20, width: f.width * 1.5, height: f.height * 2 },
      r = resizeSelection(d, f, b);
    for (const id of ["a", "b", "c"]) {
      const old = transformPoint(getWorldTransform(d, id), { x: 0, y: 0 }),
        now = transformPoint(getWorldTransform(r, id), { x: 0, y: 0 });
      close(xy(now), [
        f.basis[4] + b.x + (old.x - f.basis[4]) * 1.5,
        f.basis[5] + b.y + (old.y - f.basis[5]) * 2,
      ]);
    }
    d.nodes.c.locked = true;
    expect(transformFrame(d, ["a", "c"])!.ids).toEqual(["a"]);
  });
  it("group resize changes derived bounds and preserves unselected sibling world", () => {
    const g = groupNodes(fixture(), ["a", "b"]),
      d = g.document,
      f = transformFrame(d, g.ids)!,
      before = getWorldTransform(d, "c");
    const h = new DocumentHistory(d);
    h.execute(
      resizeSelection(d, f, {
        x: 0,
        y: 0,
        width: f.width * 2,
        height: f.height * 3,
      }),
    );
    const r = h.document;
    expect(r.nodes[g.ids[0]].width).toBeCloseTo(f.width * 2);
    expect(r.nodes[g.ids[0]].height).toBeCloseTo(f.height * 3);
    close(getWorldTransform(r, "c"), before);
  });
  it("rotation preserves center and full affine geometry through mixed parents", () => {
    const d = fixture(),
      f = transformFrame(d, ["a", "c"])!,
      r = rotateSelection(d, f, 90),
      center = transformPoint(f.basis, { x: f.width / 2, y: f.height / 2 });
    for (const id of f.ids) {
      const w = getWorldTransform(d, id);
      close(
        getWorldTransform(r, id),
        mul([0, 1, -1, 0, center.x + center.y, center.y - center.x], w),
      );
    }
    expect(parseDocument(serializeDocument(r))).toEqual(r);
  });
  it("Shift rotation quantizes absolute world angle including rotated parent", () => {
    const f = transformFrame(fixture(), ["a"])!,
      c = transformPoint(f.basis, { x: 40, y: 20 });
    const delta = rotationDelta(
      f,
      { x: c.x + 100, y: c.y },
      { x: c.x + 90, y: c.y + 20 },
      true,
    );
    expect((frameRotation(f) + delta) / 15).toBeCloseTo(
      Math.round((frameRotation(f) + delta) / 15),
    );
  });
  it("preview has one Undo/Redo, cancellation and no-op do not add history", () => {
    const d = fixture(),
      f = transformFrame(d, ["a"])!,
      h = new DocumentHistory(d);
    h.beginTransaction();
    for (const a of [10, 20, 30]) h.preview(rotateSelection(d, f, a));
    h.cancelTransaction();
    expect(h.document).toEqual(d);
    expect(h.canUndo).toBe(false);
    h.beginTransaction();
    h.preview(rotateSelection(d, f, 25));
    h.commitTransaction();
    const r = h.document;
    h.undo();
    expect(h.document).toEqual(d);
    h.redo();
    expect(h.document).toEqual(r);
    expect(
      resizeSelection(d, f, { x: 0, y: 0, width: f.width, height: f.height }),
    ).toBe(d);
    expect(rotateSelection(d, f, 0)).toBe(d);
  });
});
