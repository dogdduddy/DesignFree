import { describe, it, expect } from "vitest";
import {
  createNode,
  DocumentHistory,
  updateNodes,
  duplicateNodes,
  parseDocument,
  serializeDocument,
  validateDocument,
} from "../src/core";
import { newDocument, addPage, removePage } from "../src/documents";
import {
  makeComponent,
  createInstance,
  detachInstance,
  resetInstanceOverrides,
  reconcileComponents,
  type Instance,
} from "../src/components";
import { copySelection, pasteSelection } from "../src/clipboard";

function fixture() {
  const doc = newDocument();
  const main = createNode("frame", doc.rootId, {
    id: "main",
    children: ["label"],
    width: 200,
  });
  const label = createNode("text", main.id, {
    id: "label",
    text: {
      content: "원본",
      fontFamily: "Noto Sans KR",
      fontSize: 16,
      fontWeight: 400,
      lineHeight: 24,
    },
  });
  doc.nodes[main.id] = main;
  doc.nodes[label.id] = label;
  doc.nodes[doc.rootId].children.push(main.id);
  const result = createInstance(makeComponent(doc, main.id), main.id);
  return { h: new DocumentHistory(result.document), id: result.id };
}
function link(h: DocumentHistory, id: string) {
  return h.document.nodes[id].component as Instance;
}
function child(h: DocumentHistory, id: string) {
  return link(h, id).nodeMap.label;
}
describe("component authoring and propagation", () => {
  it("creates stable expanded identities and propagates one atomic history command", () => {
    const { h, id } = fixture(),
      cid = child(h, id),
      before = h.document;
    h.execute(
      updateNodes(h.document, {
        main: { width: 320 },
        label: { text: { ...h.document.nodes.label.text!, content: "수정" } },
      }),
    );
    expect(h.document.nodes[id].width).toBe(320);
    expect(h.document.nodes[cid].text!.content).toBe("수정");
    expect(child(h, id)).toBe(cid);
    const after = h.document;
    h.undo();
    expect(h.document).toEqual(before);
    h.redo();
    expect(h.document).toEqual(after);
    expect(h.statistics.undoEntries).toBe(1);
  });
  it("retains explicit property leaf overrides while inheriting other text properties", () => {
    const { h, id } = fixture(),
      cid = child(h, id);
    h.execute(
      updateNodes(h.document, {
        [cid]: { text: { ...h.document.nodes[cid].text!, content: "사용자" } },
      }),
    );
    h.execute(
      updateNodes(h.document, {
        label: {
          text: {
            ...h.document.nodes.label.text!,
            content: "새 원본",
            fontSize: 28,
            fontWeight: 700,
          },
        },
      }),
    );
    expect(h.document.nodes[cid].text).toMatchObject({
      content: "사용자",
      fontSize: 28,
      fontWeight: 700,
    });
    expect(link(h, id).overrides.label).toEqual({ "text.content": "사용자" });
    h.execute(
      updateNodes(h.document, {
        label: { text: { ...h.document.nodes.label.text!, content: "사용자" } },
      }),
    );
    h.execute(
      updateNodes(h.document, {
        label: {
          text: { ...h.document.nodes.label.text!, content: "다시 변경" },
        },
      }),
    );
    expect(h.document.nodes[cid].text!.content).toBe("사용자");
  });
  it("keeps root placement, resets overrides and detaches without changing geometry", () => {
    const { h, id } = fixture();
    const placement = h.document.nodes[id].transform;
    h.execute(updateNodes(h.document, { [id]: { width: 77 } }));
    h.execute(resetInstanceOverrides(h.document, id));
    expect(h.document.nodes[id].width).toBe(200);
    expect(h.document.nodes[id].transform).toEqual(placement);
    const snapshot = h.document.nodes[id];
    h.execute(detachInstance(h.document, id));
    expect(h.document.nodes[id]).toEqual({ ...snapshot, component: undefined });
    h.execute(updateNodes(h.document, { main: { width: 500 } }));
    expect(h.document.nodes[id].width).toBe(200);
  });
  it("adds, reorders and deletes source children while preserving surviving IDs/overrides", () => {
    const { h, id } = fixture(),
      cid = child(h, id);
    const d = h.document;
    const extra = createNode("rectangle", "main", { id: "extra" });
    d.nodes.extra = extra;
    d.nodes.main.children.unshift(extra.id);
    h.execute(d);
    const extraId = link(h, id).nodeMap.extra;
    expect(h.document.nodes[id].children).toEqual([extraId, cid]);
    const removed = h.document;
    delete removed.nodes.label;
    removed.nodes.main.children = ["extra"];
    h.execute(removed);
    expect(h.document.nodes[cid]).toBeUndefined();
    expect(link(h, id).nodeMap.extra).toBe(extraId);
    validateDocument(h.document);
  });
  it("propagates nested masters and nested overrides across two outer instances", () => {
    const { h, id } = fixture();
    let d = h.document;
    const outer = createNode("frame", d.rootId, { id: "outer" });
    d.nodes.outer = outer;
    d.nodes[d.rootId].children.push("outer");
    d.nodes[d.rootId].children = d.nodes[d.rootId].children.filter(
      (n) => n !== id,
    );
    d.nodes[id].parentId = "outer";
    d.nodes.outer.children = [id];
    h.execute(makeComponent(d, "outer"));
    const first = createInstance(h.document, "outer");
    h.execute(first.document);
    const second = createInstance(h.document, "outer");
    h.execute(second.document);
    const nestedLabel = child(h, id),
      outerLabel = link(h, first.id).nodeMap[nestedLabel];
    h.execute(
      updateNodes(h.document, {
        [outerLabel]: {
          text: {
            ...h.document.nodes[outerLabel].text!,
            content: "outer override",
          },
        },
      }),
    );
    h.execute(
      updateNodes(h.document, {
        [nestedLabel]: {
          text: {
            ...h.document.nodes[nestedLabel].text!,
            content: "nested override",
          },
        },
      }),
    );
    h.execute(
      updateNodes(h.document, {
        label: { text: { ...h.document.nodes.label.text!, fontSize: 32 } },
      }),
    );
    expect(h.document.nodes[outerLabel].text).toMatchObject({
      content: "outer override",
      fontSize: 32,
    });
    expect(
      h.document.nodes[link(h, second.id).nodeMap[nestedLabel]].text,
    ).toMatchObject({ content: "nested override", fontSize: 32 });
  });
  it("rejects self and indirect cycles without mutating the history", () => {
    const { h, id } = fixture(),
      before = h.document;
    expect(() => createInstance(h.document, "main", "main")).toThrow(/순환/);
    const d = h.document;
    d.nodes[d.rootId].children = d.nodes[d.rootId].children.filter(
      (x) => x !== id,
    );
    d.nodes[id].parentId = "main";
    d.nodes.main.children.push(id);
    expect(() => h.execute(d)).toThrow(/순환/);
    expect(h.document).toEqual(before);
  });
  it("rejects instance descendant insertion, deletion and reparenting until detached", () => {
    const { h, id } = fixture(),
      cid = child(h, id),
      before = h.document;
    const d = h.document;
    d.nodes[id].children = [];
    delete d.nodes[cid];
    expect(() => h.execute(d)).toThrow(/분리/);
    expect(h.document).toEqual(before);
    const added = h.document;
    const n = createNode("rectangle", id);
    added.nodes[n.id] = n;
    added.nodes[id].children.push(n.id);
    expect(() => h.execute(added)).toThrow(/분리/);
    h.execute(detachInstance(h.document, id));
    h.execute(d); // no longer linked: arbitrary structures permitted
  });
  it("detaches surviving snapshots on source/page deletion and restores links on undo", () => {
    const { h, id } = fixture();
    const d = addPage(h.document),
      newPage = d.rootId;
    const oldParent = d.nodes[id].parentId!;
    d.nodes[oldParent].children = d.nodes[oldParent].children.filter(
      (x) => x !== id,
    );
    d.nodes[newPage].children = [id];
    d.nodes[id].parentId = newPage;
    h.execute(d);
    const before = h.document;
    const removed = { ...h.document, rootId: oldParent };
    h.execute(removePage(removed));
    expect(h.document.nodes[id].component).toBeUndefined();
    expect(h.document.nodes[before.nodes[id].children[0]].text!.content).toBe(
      "원본",
    );
    h.undo();
    expect(h.document).toEqual(before);
  });
  it("remaps duplicate instance identities and copies a main/instance pair independently", () => {
    const { h, id } = fixture();
    const result = duplicateNodes(h.document, [id]);
    h.execute(result.document);
    const c = link(h, result.ids[0]);
    expect(c.nodeMap.main).toBe(result.ids[0]);
    expect(c.nodeMap.label).not.toBe(child(h, id));
    h.execute(updateNodes(h.document, { main: { width: 450 } }));
    expect(h.document.nodes[result.ids[0]].width).toBe(450);
    const pair = duplicateNodes(h.document, ["main", id]);
    h.execute(pair.document);
    expect(link(h, pair.ids[1]).sourceId).toBe(pair.ids[0]);
    h.execute(updateNodes(h.document, { [pair.ids[0]]: { width: 180 } }));
    expect(h.document.nodes[pair.ids[1]].width).toBe(180);
    expect(h.document.nodes[id].width).toBe(450);
  });
  it("preserves source/override identity through JSON and portable clipboard snapshots", () => {
    const { h, id } = fixture();
    const roundtrip = new DocumentHistory(
      parseDocument(serializeDocument(h.document)),
    );
    expect(roundtrip.document).toEqual(h.document);
    const copied = copySelection(h.document, [id])!;
    const pasted = pasteSelection(h.document, copied.json, []);
    h.execute(pasted.document);
    expect(h.document.nodes[pasted.ids[0]].component).toBeUndefined();
    expect(h.document.nodes[pasted.ids[0]].children).toHaveLength(1);
  });
  it("does not turn propagated preview properties into overrides on subsequent pointer previews", () => {
    const { h, id } = fixture();
    h.beginTransaction();
    const base = h.document;
    h.preview(updateNodes(base, { main: { width: 210 } }));
    h.preview(updateNodes(base, { main: { width: 220 } }));
    h.commitTransaction();
    expect(h.document.nodes[id].width).toBe(220);
    expect(link(h, id).overrides.main.width).toBeUndefined();
  });
  it("rejects unsafe metadata paths", () => {
    const { h, id } = fixture();
    const d = h.document;
    (d.nodes[id].component as Instance).overrides.label = {
      "text.__proto__": "bad",
    };
    expect(() => parseDocument(JSON.stringify(d))).toThrow();
  });
});

it("new optional style objects keep leaf overrides and inherit later source fields", () => {
  const { h, id } = fixture();
  const cid = child(h, id);
  h.execute(
    updateNodes(h.document, { [cid]: { stroke: { width: 2, color: "#f00" } } }),
  );
  h.execute(
    updateNodes(h.document, {
      label: {
        stroke: { width: 5, color: "#00f", position: "outside", dash: [3, 4] },
      },
    }),
  );
  expect(h.document.nodes[cid].stroke).toEqual({
    width: 2,
    color: "#f00",
    position: "outside",
    dash: [3, 4],
  });
});

it("source stroke removal preserves partial overrides without blocking edits or later inheritance", () => {
  const { h, id } = fixture();
  const cid = child(h, id);
  h.execute(
    updateNodes(h.document, { label: { stroke: { width: 2, color: "#00f" } } }),
  );
  h.execute(
    updateNodes(h.document, {
      [cid]: { stroke: { ...h.document.nodes[cid].stroke!, width: 4 } },
    }),
  );
  h.execute(updateNodes(h.document, { label: { stroke: undefined } }));
  expect(h.document.nodes[cid].stroke).toEqual({ width: 4, color: "#00f" });
  h.execute(
    updateNodes(h.document, { label: { stroke: { width: 8, color: "#0f0" } } }),
  );
  expect(h.document.nodes[cid].stroke).toEqual({ width: 4, color: "#0f0" });
});

it("duplicating a source child beside an instance keeps overrides on the original source identity", () => {
  const { h, id } = fixture();
  const cid = child(h, id);
  h.execute(
    updateNodes(h.document, {
      [cid]: { text: { ...h.document.nodes[cid].text!, content: "local" } },
    }),
  );
  const copy = duplicateNodes(h.document, ["label", id]);
  h.execute(copy.document);
  const c = link(h, copy.ids[1]);
  expect(c.sourceId).toBe("main");
  expect(h.document.nodes[c.nodeMap.label].text!.content).toBe("local");
  expect(h.document.nodes[c.nodeMap[copy.ids[0]]].text!.content).toBe("원본");
  expect(c.overrides.label).toEqual({ "text.content": "local" });
});
