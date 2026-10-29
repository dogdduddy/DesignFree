import { describe, it, expect, vi } from "vitest";
import { createNode, type SceneDocument } from "../src/core";
import { exportFrameWeb, prepareFrameWeb } from "../src/web-export";
function fixture() {
  const page = createNode("page", null, { id: "page", children: ["frame"] });
  const frame = createNode("frame", "page", {
    id: "frame",
    children: ["child"],
    width: 300,
    height: 100,
    transform: [1, 0, 0, 1, 90, 80],
    layout: { mode: "flex", gap: 10 },
  });
  const child = createNode("rectangle", "frame", {
    id: "child",
    width: 60,
    height: 30,
    transform: [1, 0, 0, 1, 12, 15],
    fill: { type: "solid", color: "#f008", opacity: 0.5 },
  });
  return {
    schemaVersion: 1,
    id: "web",
    name: "web",
    rootId: "page",
    nodes: { page, frame, child },
    assets: {},
  } as SceneDocument;
}
describe("frame HTML/CSS export", () => {
  it("exports computed layout, local root and preserves authoring", () => {
    const doc = fixture(),
      before = JSON.stringify(doc),
      result = exportFrameWeb(doc, "frame");
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.css).toContain("matrix(1,0,0,1,0,0)");
    expect(result.css).toContain("display:flex");
    expect(result.css).toContain("position:relative");
    expect(result.css).toContain("width:100%");
    expect(result.css).not.toContain("90,80");
    expect(result.css).toContain("rgba(255,0,0,0.26666666666666666)");
    expect(result.html).not.toContain("<svg");
    expect(result.warnings[0]).toContain("반응형");
  });
  it("escapes names/content/ids and confines executable or network content", () => {
    const doc = fixture();
    doc.nodes.frame.name = "</title><script>alert(1)</script>";
    doc.nodes.child = createNode("text", "frame", {
      id: "child",
      text: {
        content: "<img src=x onerror=alert(1)>",
        fontFamily: "x';}body{background:url(https://bad)}",
        fontSize: 16,
        fontWeight: 400,
        lineHeight: 24,
      },
    });
    const result = exportFrameWeb(doc, "frame");
    expect(result.html).not.toContain("<script");
    expect(result.html).not.toContain("<img src=x");
    expect(result.css).not.toContain("https:");
    expect(result.html).toContain("default-src 'none'");
    expect(result.warnings.join()).toContain("누락 폰트");
    expect(() => exportFrameWeb(doc, "frame", "https://bad")).toThrow();
  });
  it("omits hidden subtrees and warns on unsupported paints/strokes", () => {
    const doc = fixture();
    doc.nodes.child.visible = false;
    expect(exportFrameWeb(doc, "frame").html).not.toContain(
      'data-node-id="child"',
    );
    doc.nodes.child.visible = true;
    doc.nodes.child.stroke = { color: "#fff", width: 2 };
    doc.nodes.child.fill = {
      type: "linear",
      from: [0, 0],
      to: [1, 1],
      stops: [
        { offset: 0, color: "#fff" },
        { offset: 1, color: "#000" },
      ],
    };
    expect(exportFrameWeb(doc, "frame").warnings.join()).toContain("gradient");
    expect(exportFrameWeb(doc, "frame").warnings.join()).toContain("stroke");
  });
  it("rejects non-frames and missing PNG bytes", () => {
    const doc = fixture();
    expect(() => exportFrameWeb(doc, "page")).toThrow();
    doc.nodes.child.type = "image";
    doc.nodes.child.assetId = "asset";
    doc.assets.asset = {
      id: "asset",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAA",
      width: 1,
      height: 1,
      missing: "a".repeat(64),
    };
    expect(() => exportFrameWeb(doc, "frame")).toThrow(/PNG/);
  });
  it("keeps rounded clipping on groups and font license in CSS", () => {
    const doc = fixture();
    doc.nodes.child.type = "group";
    doc.nodes.child.clipContent = true;
    doc.nodes.child.radius = 12;
    const result = exportFrameWeb(doc, "frame", "data:font/ttf;base64,AAAA");
    expect(result.css).toContain("border-radius:12px");
    expect(result.css).toContain("SIL OPEN FONT LICENSE");
  });
  it("warns and freezes unsupported hug, wrapped cross fill and Grid auto-fill", () => {
    const doc = fixture();
    for (const layout of [
      { mode: "flex", width: "hug" },
      { mode: "flex", wrap: true },
      { mode: "grid", grid: { columns: ["auto"], rows: [30] } },
    ] as const) {
      doc.nodes.frame.layout = structuredClone(
        layout,
      ) as typeof doc.nodes.frame.layout;
      doc.nodes.child.layout = {
        mode: "absolute",
        width: "fill",
        height: "fill",
      };
      const result = exportFrameWeb(doc, "frame");
      expect(result.warnings.join()).toContain("대응 불가");
      expect(result.css).not.toMatch(/display:(flex|grid)/);
      expect(result.css).toContain("position:relative");
      expect(result.css).not.toContain("width:100%");
    }
  });
  it("limits warnings to the visible exported subtree", () => {
    const doc = fixture();
    doc.nodes.other = createNode("frame", "page", {
      id: "other",
      name: "unrelated",
      layout: { mode: "flex", width: "hug" },
    });
    doc.nodes.page.children.push("other");
    doc.nodes.child.visible = false;
    doc.nodes.child.type = "frame";
    doc.nodes.child.layout = { mode: "grid", width: "hug" };
    const result = exportFrameWeb(doc, "frame");
    expect(result.warnings.join()).not.toContain("unrelated");
    expect(result.warnings.join()).not.toContain("대응 불가");
  });
  it("keeps explicit absolute children at authored offsets and warns on text reflow", () => {
    const doc = fixture();
    doc.nodes.child.layout.position = "absolute";
    const result = exportFrameWeb(doc, "frame");
    expect(result.css).toContain("matrix(1,0,0,1,12,15)");
    doc.nodes.child.type = "text";
    doc.nodes.child.text = {
      content: "long text",
      fontFamily: "sans-serif",
      fontSize: 16,
      fontWeight: 400,
      lineHeight: 24,
    };
    expect(exportFrameWeb(doc, "frame").warnings.join()).toContain("재줄바꿈");
  });
  it("retains authored radius so CSS clamps against the responsive box", () => {
    const doc = fixture();
    doc.nodes.frame.width = 100;
    doc.nodes.frame.height = 200;
    doc.nodes.frame.radius = 100;
    expect(exportFrameWeb(doc, "frame").css).toContain("border-radius:100px");
  });
  it("browser export rejects PNG decode failures", async () => {
    const doc = fixture();
    doc.nodes.child.type = "image";
    doc.nodes.child.assetId = "asset";
    doc.assets.asset = {
      id: "asset",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAA",
      width: 1,
      height: 1,
    };
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        decode() {
          return Promise.reject(new Error("invalid"));
        }
      },
    );
    try {
      await expect(
        prepareFrameWeb(doc, "frame", "data:font/ttf;base64,AAAA"),
      ).rejects.toThrow(/PNG/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
