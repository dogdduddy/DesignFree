import { describe, expect, it } from "vitest";
import { createNode, type SceneDocument } from "../src/core";
import { marqueeBox, marqueeSelection } from "../src/marquee";
function fixture(): SceneDocument {
  return {
    schemaVersion: 1,
    id: "doc",
    name: "Marquee",
    rootId: "page",
    assets: {},
    nodes: {
      page: createNode("page", null, { id: "page", children: ["f", "c"] }),
      f: createNode("frame", "page", {
        id: "f",
        width: 200,
        height: 200,
        transform: [1, 0, 0, 1, 100, 100],
        children: ["a", "b"],
        clipContent: true,
      }),
      a: createNode("rectangle", "f", {
        id: "a",
        width: 20,
        height: 20,
        transform: [1, 0, 0, 1, 20, 20],
      }),
      b: createNode("rectangle", "f", {
        id: "b",
        width: 20,
        height: 20,
        transform: [1, 0, 0, 1, 80, 80],
      }),
      c: createNode("rectangle", "page", {
        id: "c",
        width: 20,
        height: 20,
        transform: [1, 0, 0, 1, 350, 100],
      }),
    },
  };
}
const select = (
  d: SceneDocument,
  x: number,
  y: number,
  xx: number,
  yy: number,
  scope?: string,
) => marqueeSelection(d, { x, y }, { x: xx, y: yy }, scope);
describe("marqueeSelection", () => {
  it("normalizes reverse drags and includes fully contained frames once", () => {
    expect(marqueeBox({ x: 400, y: 320 }, { x: 90, y: 80 })).toEqual({
      x: 90,
      y: 80,
      width: 310,
      height: 240,
    });
    expect(select(fixture(), 400, 320, 90, 80)).toEqual(["f", "c"]);
  });
  it("descends into partially covered frames and requires full containment", () => {
    expect(select(fixture(), 110, 110, 150, 150)).toEqual(["a"]);
    expect(select(fixture(), 125, 125, 150, 150)).toEqual([]);
  });
  it("scopes frame background selection to children", () => {
    expect(select(fixture(), 0, 0, 500, 500, "f")).toEqual(["a", "b"]);
  });
  for (const flag of ["visible", "locked"] as const) {
    it(`excludes inherited ${flag} and direct ${flag}`, () => {
      const d = fixture();
      d.nodes.f[flag] = flag === "locked";
      d.nodes.c[flag] = flag === "locked";
      expect(select(d, 0, 0, 500, 500)).toEqual([]);
      expect(select(d, 0, 0, 500, 500, "f")).toEqual([]);
    });
  }
  it("uses nested affine world corners and tolerates exact edges", () => {
    const d = fixture();
    d.nodes.f.transform = [0, 2, -1, 0, 300, 100];
    expect(select(d, 260, 140, 280, 180, "f")).toEqual(["a"]);
    expect(select(d, 260, 140, 279, 180, "f")).toEqual([]);
  });
  it("excludes fully clipped descendants but considers partially clipped authored boxes", () => {
    const d = fixture();
    d.nodes.a.transform[4] = 250;
    expect(select(d, 0, 0, 600, 600, "f")).toEqual(["b"]);
    d.nodes.a.transform[4] = 195;
    expect(select(d, 0, 0, 600, 600, "f")).toEqual(["a", "b"]);
    d.nodes.f.clipContent = false;
    d.nodes.a.transform[4] = 250;
    expect(select(d, 0, 0, 600, 600, "f")).toEqual(["a", "b"]);
  });
  it("does not select zero-area or singular geometry", () => {
    const d = fixture();
    d.nodes.a.width = 0;
    d.nodes.b.transform = [0, 0, 0, 0, 0, 0];
    expect(select(d, 0, 0, 600, 600, "f")).toEqual([]);
  });
  it("skips non-invertible clipping ancestors even when a child compensates their scale", () => {
    const d = fixture();
    d.nodes.f.transform = [1e-8, 0, 0, 1e-8, 100, 100];
    d.nodes.a.transform = [1e8, 0, 0, 1e8, 0, 0];
    expect(select(d, 0, 0, 600, 600, "f")).toEqual([]);
  });
  it("has no document mutation and no hits for empty/zero-width marquee", () => {
    const d = fixture(),
      before = structuredClone(d);
    expect(select(d, 0, 0, 10, 10)).toEqual([]);
    expect(select(d, 120, 120, 120, 150)).toEqual([]);
    expect(d).toEqual(before);
  });
});
