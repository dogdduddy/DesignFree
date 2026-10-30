import { describe, it, expect, vi } from "vitest";
import { createNode, type SceneDocument } from "../src/core";
import { exportFrameWeb, prepareFrameWeb } from "../src/web-export";
import { styleVariable, webStyleVariables } from "../src/web-style-variables";
import { computeLayout } from "../src/flex-layout";
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
  it("keeps auto-sized text dimensions computed when numeric fallback dimensions are bound", () => {
    for (const sizing of ["auto-width", "auto-height", "fixed"] as const) {
      const doc = fixture();
      doc.nodes.frame.layout = { mode: "absolute" };
      doc.nodes.child = createNode("text", "frame", {
        id: "child",
        width: 300,
        height: 300,
        text: {
          content: "ii",
          sizing,
          fontFamily: "sans-serif",
          fontSize: 16,
          fontWeight: 400,
          lineHeight: 24,
        },
        styleRefs: { width: "size", height: "size" },
      });
      doc.styleLibrary = {
        tokens: {},
        styles: { size: { kind: "number", name: "Size", value: 300 } },
        themes: {},
      };
      const before = JSON.stringify(doc),
        computed = computeLayout(doc).nodes.child;
      const result = exportFrameWeb(doc, "frame");
      const rule = result.css.match(/\.dr-t0-1\{([^}]+)\}/)![1];
      for (const axis of ["width", "height"] as const) {
        const auto =
          sizing === "auto-width" ||
          (sizing === "auto-height" && axis === "height");
        expect(rule).toContain(
          `${axis}:${auto ? `${computed[axis]}px` : `var(${styleVariable("style", "size")})`}`,
        );
        if (auto) expect(rule).not.toContain(`${axis}:var(`);
      }
      expect(JSON.stringify(doc)).toBe(before);
    }
  });
  it("exports numeric aliases and themed fixed dimensions without changing authored fallbacks", () => {
    const doc = fixture();
    doc.styleLibrary = {
      tokens: {
        size: { kind: "number", name: "Size", value: 70 },
        alias: { kind: "number", name: "Alias", value: { ref: "size" } },
        space: { kind: "spacing", name: "Space", value: 12 },
        round: { kind: "radius", name: "Round", value: 6 },
      },
      styles: {
        size: { kind: "number", name: "Size", value: { ref: "alias" } },
        space: { kind: "spacing", name: "Space", value: { ref: "space" } },
        round: { kind: "radius", name: "Round", value: { ref: "round" } },
      },
      themes: {
        large: { name: "Large", values: { size: 110, space: 20, round: 10 } },
      },
      activeTheme: "large",
    };
    doc.nodes.frame.styleRefs = { gap: "space", padding: "space" };
    doc.nodes.child.styleRefs = {
      width: "size",
      height: "size",
      radius: "round",
    };
    const before = JSON.stringify(doc),
      result = exportFrameWeb(doc, "frame");
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.css).toContain(`${styleVariable("token", "size")}:110px`);
    expect(result.css).toContain(`${styleVariable("token", "size")}:70px`);
    expect(result.css).toContain(
      `${styleVariable("token", "alias")}:var(${styleVariable("token", "size")})`,
    );
    for (const [property, id] of [
      ["width", "size"],
      ["height", "size"],
      ["gap", "space"],
      ["padding", "space"],
      ["border-radius", "round"],
    ])
      expect(result.css).toContain(
        `${property}:var(${styleVariable("style", id)})`,
      );
    const base = webStyleVariables(doc.styleLibrary);
    expect(base).toContain(`${styleVariable("token", "space")}:12px`);
    expect(base).toContain(`${styleVariable("token", "round")}:6px`);
    // Binding a fallback dimension must not override computed fill/hug sizing.
    doc.nodes.child.layout.width = "fill";
    doc.nodes.child.layout.height = "hug";
    const derived = exportFrameWeb(doc, "frame");
    expect(derived.css).not.toContain(
      `width:var(${styleVariable("style", "size")})`,
    );
    expect(derived.css).not.toContain(
      `height:var(${styleVariable("style", "size")})`,
    );
    // Unsupported intrinsic layout keeps its derived positions and padding snapshot.
    doc.nodes.frame.layout.width = "hug";
    const frozen = exportFrameWeb(doc, "frame");
    expect(frozen.css).not.toContain(
      `padding:var(${styleVariable("style", "space")})`,
    );
    expect(frozen.css).not.toContain(
      `gap:var(${styleVariable("style", "space")})`,
    );
  });
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
