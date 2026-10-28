import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoDocument } from "../src/core";
import {
  exportPng,
  exportSvg,
  pngExportDimensions,
} from "../src/renderers/svg";

describe("PNG export validation", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("rejects unsupported scales and unsafe imported page sizes before browser work", async () => {
    const fetch = vi.fn();
    const createElement = vi.fn();
    const FontFace = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("document", { createElement });
    vi.stubGlobal("FontFace", FontFace);
    const doc = createDemoDocument();
    for (const scale of [0, -1, 1.5, 5, NaN, Infinity])
      await expect(exportPng(doc, scale)).rejects.toThrow("scale");
    for (const [width, height] of [
      [NaN, 10],
      [10, Infinity],
      [0, 20],
      [-1, 20],
      [1e308, 10],
      [16385, 1],
      [8001, 8000],
    ]) {
      Object.assign(doc.nodes[doc.rootId], { width, height });
      await expect(exportPng(doc, 1)).rejects.toThrow(/positive|exceeds/);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(FontFace).not.toHaveBeenCalled();
    expect(createElement).not.toHaveBeenCalled();
  });
  it("rounds fractional page edges up and includes safe side/pixel boundaries", () => {
    expect(pngExportDimensions(12.25, 10.1, 3)).toEqual({
      width: 37,
      height: 31,
    });
    expect(pngExportDimensions(8000, 8000, 1)).toEqual({
      width: 8000,
      height: 8000,
    });
    expect(pngExportDimensions(4096, 1, 4)).toEqual({
      width: 16384,
      height: 4,
    });
    expect(() => pngExportDimensions(4096.1, 1, 4)).toThrow("exceeds");
    expect(() => pngExportDimensions(4000.01, 4000, 2)).toThrow("exceeds");
  });
});

describe("PNG rasterization contract", () => {
  let source: Blob;
  let canvas: {
    width: number;
    height: number;
    getContext: ReturnType<typeof vi.fn>;
    toBlob: ReturnType<typeof vi.fn>;
  };
  let decode: ReturnType<typeof vi.fn>;
  let revoke: ReturnType<typeof vi.fn>;
  let draw: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    draw = vi.fn();
    canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage: draw })),
      toBlob: vi.fn((callback) =>
        callback(new Blob(["png"], { type: "image/png" })),
      ),
    };
    decode = vi.fn(async () => {});
    revoke = vi.fn();
    vi.stubGlobal(
      "FontFace",
      class {
        async load() {
          return this;
        }
      },
    );
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        decode = decode;
      },
    );
    vi.stubGlobal("document", {
      fonts: { add() {}, ready: Promise.resolve() },
      createElement: vi.fn(() => canvas),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      })),
    );
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn((blob) => {
        source = blob;
        return "blob:export";
      }),
      revokeObjectURL: revoke,
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("decodes vectors at the default 2x size and embeds all variable font weights", async () => {
    const doc = createDemoDocument();
    const root = doc.nodes[doc.rootId];
    const unchanged = exportSvg(doc);
    await exportPng(doc);
    const svg = await source.text();
    expect(svg).toContain(
      `width="${root.width * 2}" height="${root.height * 2}" viewBox="0 0 ${root.width} ${root.height}"`,
    );
    expect(svg).toContain("font-weight:100 900");
    expect(svg).toContain("data:font/ttf;base64,AQID");
    expect(canvas.width).toBe(root.width * 2);
    expect(canvas.height).toBe(root.height * 2);
    expect(draw.mock.calls[0].slice(1)).toEqual([
      0,
      0,
      root.width * 2,
      root.height * 2,
    ]);
    expect(exportSvg(doc)).toBe(unchanged);
    expect(revoke).toHaveBeenCalledWith("blob:export");
  });
  it("reports image decode failure and revokes its URL without allocating a canvas", async () => {
    decode.mockRejectedValue(new Error("browser decode failure"));
    await expect(exportPng(createDemoDocument(), 4)).rejects.toThrow(
      "could not decode",
    );
    expect(document.createElement).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:export");
  });
  it("revokes its URL when the browser cannot encode PNG", async () => {
    canvas.toBlob.mockImplementation((callback) => callback(null));
    await expect(exportPng(createDemoDocument(), 1)).rejects.toThrow(
      "encoding failed",
    );
    expect(revoke).toHaveBeenCalledWith("blob:export");
  });
});
