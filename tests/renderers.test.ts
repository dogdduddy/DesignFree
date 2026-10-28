import { describe, it, expect } from "vitest";
import { createDemoDocument } from "../src/core";
import { exportSvg, escapeXml } from "../src/renderers/svg";
describe("safe portable scene markup", () => {
  it("escapes XML syntax including text and attribute delimiters", () =>
    expect(escapeXml('<img x="a"/> & \'')).toBe(
      "&lt;img x=&quot;a&quot;/&gt; &amp; &apos;",
    ));
  it("serializes transforms, definitions and text without script injection", () => {
    const doc = createDemoDocument();
    const text = Object.values(doc.nodes).find((n) => n.type === "text")!;
    text.text!.content = '<script>alert("x")</script>\n둘째 줄';
    const svg = exportSvg(doc);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("둘째 줄");
    expect(svg).toContain("<clipPath");
    expect(svg).toContain("<linearGradient");
    expect(svg).toContain("data:image/png;base64,");
    expect(svg).toContain('transform="matrix(');
  });
  it("omits invisible subtrees and rejects missing image assets", () => {
    const doc = createDemoDocument();
    const image = Object.values(doc.nodes).find((n) => n.type === "image")!;
    image.assetId = "missing";
    expect(() => exportSvg(doc)).toThrow("Missing or invalid");
    image.visible = false;
    expect(() => exportSvg(doc)).not.toThrow();
  });
  it("expands normalized diagonal gradients into local pixels after resize", () => {
    const doc = createDemoDocument();
    const node = Object.values(doc.nodes).find(
      (n) => n.fill.type === "linear",
    )!;
    node.width = 200;
    node.height = 100;
    expect(exportSvg(doc)).toContain(
      'gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="200" y2="100"',
    );
    node.width = 400;
    expect(exportSvg(doc)).toContain(
      'gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="400" y2="100"',
    );
  });
});
