import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

// I01: SVG import → editable nodes → SVG export round trip, through the source
// modules (pixels, CanvasKit) and the real editor UI (upload, Undo, autosave).
const url = process.env.EDITOR_URL || process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/";
const PNG = (await fs.readFile(new URL("../src/assets.ts", import.meta.url), "utf8")).match(
  /"(data:image\/png;base64,[^"]+)"/,
)[1];

// Supported subset, without text (fonts differ between engines) and with butt
// caps/miter joins, so the round trip can be compared pixel by pixel.
const shapes = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="240" height="160" viewBox="0 0 120 80">
  <defs>
    <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff6600"/><stop offset="100%" stop-color="#3366ff" stop-opacity=".8"/></linearGradient>
    <linearGradient id="lg2" href="#lg" x1="0" x2="0" y2="1"/>
    <radialGradient id="rg" gradientUnits="userSpaceOnUse" cx="90" cy="20" r="15"><stop offset="0" stop-color="white"/><stop offset="1" stop-color="teal"/></radialGradient>
    <style>.accent { fill: #c0392b } #star { stroke: navy }</style>
    <g id="dot"><circle cx="0" cy="0" r="4" fill="gold"/></g>
  </defs>
  <rect width="120" height="80" fill="#f4f1ea"/>
  <rect x="4" y="4" width="50" height="30" rx="6" fill="url(#lg)"/>
  <rect x="58" y="4" width="14" height="30" fill="url(#lg2)"/>
  <circle cx="90" cy="20" r="15" fill="url(#rg)" stroke="#222" stroke-width="2"/>
  <g transform="translate(10 44) rotate(-10)" opacity="0.8" fill="green">
    <ellipse cx="20" cy="12" rx="18" ry="10"/>
    <polygon id="star" class="accent" points="50,0 56,18 75,18 60,29 66,47 50,36 34,47 40,29 25,18 44,18" stroke-width="1.5"/>
  </g>
  <path d="M78 50 q10 -20 20 0 t20 0" fill="none" stroke="purple" stroke-width="3" stroke-dasharray="4 2"/>
  <path fill-rule="evenodd" d="M88 58h22v18h-22z M94 63h10v8h-10z" style="fill: rgb(52, 73, 94)"/>
  <path d="M70 70 a6 6 0 1 0 12 0 a6 6 0 1 0 -12 0z" fill="hsl(200, 70%, 50%)"/>
  <line x1="2" y1="78" x2="118" y2="78" stroke="#999"/>
  <polyline points="2,40 8,36 14,40 20,36" fill="none" stroke="black"/>
  <use href="#dot" x="112" y="8"/>
  <use xlink:href="#dot" x="8" y="72"/>
  <image x="60" y="38" width="12" height="12" href="${PNG}"/>
</svg>`;

// Unsupported or unsafe features: each must be left out with a warning, and
// nothing may run or load.
const unsafe = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" onload="window.__svgRan='onload'">
  <script>window.__svgRan = 'script'</script>
  <style>@import url(http://127.0.0.1:9/x.css); g rect { fill: red }</style>
  <defs><clipPath id="c"><rect width="10" height="10"/></clipPath><filter id="f"><feGaussianBlur stdDeviation="2"/></filter>
    <pattern id="p" width="4" height="4"><rect width="2" height="2"/></pattern></defs>
  <rect width="50" height="50" clip-path="url(#c)" filter="url(#f)" onclick="window.__svgRan='click'"/>
  <rect x="50" width="50" height="50" fill="url(#p) orange" stroke="black" stroke-linecap="round"/>
  <image href="http://127.0.0.1:9/remote.png" width="10" height="10"/>
  <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
  <circle cx="20" cy="80" r="10"><animate attributeName="r" from="10" to="20" dur="1s"/></circle>
  <svg x="60" y="60" width="40" height="40" viewBox="0 0 10 10"><rect width="20" height="20" fill="blue"/></svg>
  <text x="10" y="95">Hello <tspan font-weight="bold" fill="red">SVG</tspan></text>
  <use href="other.svg#icon"/>
</svg>`;

const textSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120">
  <text x="100" y="40" font-size="20" font-family="'Noto Sans KR', sans-serif" text-anchor="middle" fill="#333">가운데 Middle</text>
  <text x="10" y="80" font-size="16" font-weight="bold" letter-spacing="1"><tspan x="10" dy="0">First line</tspan><tspan x="10" dy="20">Second line</tspan></text>
</svg>`;

// Values that used to break: symbol styles, unit-bearing text positions, and
// elements whose values the model rejects (each must be skipped, not fatal).
const edge = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
  <defs><symbol id="s" fill="red"><rect width="10" height="10"/></symbol>
    <linearGradient id="bad" x1="1e999"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs>
  <use href="#s" x="5" y="5"/>
  <text x="50%" y="50%" text-anchor="middle" font-size="10">Centre<tspan x="50%" dy="1.2em">next</tspan></text>
  <text x="10" y="90" font-size="10"><tspan x="30">tspan x</tspan></text>
  <text x="0" y="10" font-size="0">zero</text>
  <path d="M0 0 L 20000000 0" stroke="black"/>
  <rect x="150" y="10" width="20" height="20" fill="url(#bad)"/>
  <rect x="150" y="50" width="20" height="20" fill="teal"/>
</svg>`;

const report = { url, checks: [], pixels: {}, warnings: {} };
const browser = await chromium.launch(browserLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  const external = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().includes("127.0.0.1:9")) external.push(r.url());
  });
  await page.goto(new URL("bench.html", url).href, { waitUntil: "networkidle" });

  const model = await page.evaluate(
    async ({ shapes, unsafe, textSvg, edge }) => {
      const core = await import("/src/core/index.ts");
      const { parseSvg, insertSvg, browserToPng } = await import("/src/svg-import.ts");
      const { exportSvg } = await import("/src/renderers/svg.ts");
      const { createCanvasKitEngine } = await import("/src/renderers/canvaskit.ts");
      const W = 240, H = 160;
      const blank = () => {
        const page = core.createNode("page", null, { id: "page", width: W, height: H, fill: { type: "solid", color: "#ffffff" } });
        return { schemaVersion: 1, id: "svg-test", name: "SVG", rootId: "page", nodes: { page }, assets: {} };
      };
      const load = async (svg) => {
        const fragment = await parseSvg(svg, { name: "fixture", center: { x: W / 2, y: H / 2 }, toPng: browserToPng });
        // History normalization (group bounds, text bounds) applies on commit.
        const doc = new core.DocumentHistory(insertSvg(blank(), fragment, "page")).document;
        return { fragment, doc };
      };
      const raster = async (svgText) => {
        const img = new Image();
        const u = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
        img.src = u;
        await img.decode();
        URL.revokeObjectURL(u);
        return pixels(img);
      };
      const pixels = (source) => {
        const c = document.createElement("canvas");
        c.width = W;
        c.height = H;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(source, 0, 0, W, H);
        return ctx.getImageData(0, 0, W, H).data;
      };
      const compare = (a, b) => {
        let total = 0, over = 0;
        for (let i = 0; i < a.length; i += 4) {
          let worst = 0;
          for (let k = 0; k < 3; k++) {
            const d = Math.abs(a[i + k] - b[i + k]);
            total += d;
            worst = Math.max(worst, d);
          }
          if (worst > 64) over++;
        }
        return { meanAbsoluteChannelError: total / ((a.length / 4) * 3), pixelsOver64: over / (a.length / 4) };
      };
      const types = (doc) => {
        const counts = {};
        for (const n of Object.values(doc.nodes)) counts[n.type] = (counts[n.type] ?? 0) + 1;
        return counts;
      };

      const original = await raster(shapes);
      const first = await load(shapes);
      const exported = exportSvg(first.doc);
      const once = await raster(exported);
      const second = await load(exported);
      const twice = await raster(exportSvg(second.doc));

      const host = document.createElement("div");
      document.body.append(host);
      const ck = await createCanvasKitEngine(host, W, H);
      ck.update(first.doc, { x: 0, y: 0, zoom: 1 });
      const ckBlob = await new Promise((r) => host.querySelector("canvas").toBlob(r));
      const ckImg = new Image();
      ckImg.src = URL.createObjectURL(ckBlob);
      await ckImg.decode();
      const ckPixels = pixels(ckImg);
      ck.destroy();

      const paths = Object.values(first.doc.nodes).filter((n) => n.type === "path");
      const unsafeResult = await load(unsafe);
      const text = await load(textSvg);
      const texts = Object.values(text.doc.nodes).filter((n) => n.type === "text");
      // A JPEG data URL is converted to an owned PNG asset.
      const c = document.createElement("canvas");
      c.width = 8;
      c.height = 4;
      c.getContext("2d").fillRect(0, 0, 8, 4);
      const jpeg = await load(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><image width="8" height="4" href="${c.toDataURL("image/jpeg")}"/></svg>`);
      const edgeResult = await load(edge);
      const edgeNodes = Object.values(edgeResult.doc.nodes);
      let rejected = "";
      try {
        await parseSvg("<html><body>no</body></html>", { name: "x", center: { x: 0, y: 0 } });
      } catch (e) {
        rejected = e.message;
      }
      return {
        firstTypes: types(first.doc),
        firstWarnings: first.fragment.warnings,
        exportedOnce: compare(original, once),
        exportedTwice: compare(original, twice),
        canvasKit: compare(once, ckPixels),
        evenodd: paths.some((n) => n.path.fillRule === "evenodd"),
        dashed: paths.some((n) => n.stroke?.dash?.join() === "4,2"),
        frame: first.fragment.frame.width + "x" + first.fragment.frame.height,
        unsafeWarnings: unsafeResult.fragment.warnings,
        unsafeTypes: types(unsafeResult.doc),
        texts: texts.map((n) => ({ content: n.text.content, align: n.text.align, x: n.transform[4], y: n.transform[5], width: n.width, fontSize: n.text.fontSize, fontWeight: n.text.fontWeight, lineHeight: n.text.lineHeight })),
        jpegAsset: Object.values(jpeg.doc.assets).map((a) => [a.mimeType, a.width, a.height, a.dataUrl.slice(0, 22)]),
        rejected,
        edge: {
          warnings: edgeResult.fragment.warnings,
          symbolFill: edgeNodes.find((n) => n.type === "rectangle" && n.width === 10)?.fill,
          texts: edgeNodes.filter((n) => n.type === "text").map((n) => ({ content: n.text.content, x: n.transform[4], width: n.width, lineHeight: n.text.lineHeight })),
          rectangles: edgeNodes.filter((n) => n.type === "rectangle").length,
          paths: edgeNodes.filter((n) => n.type === "path").length,
        },
        ran: window.__svgRan ?? null,
      };
    },
    { shapes, unsafe, textSvg, edge },
  );
  report.model = model;
  console.log(JSON.stringify({ ...model, firstWarnings: model.firstWarnings, unsafeWarnings: model.unsafeWarnings.length }, null, 2));

  assert.deepEqual(errors, []);
  assert.equal(model.ran, null, "no script or handler ran");
  assert.deepEqual(external, [], "no external request");
  assert.equal(model.frame, "240x160");
  assert.equal(model.firstTypes.rectangle, 3); // background + two rects
  assert.equal(model.firstTypes.ellipse, 4); // circle, ellipse, two used dots
  assert.equal(model.firstTypes.path, 6); // polygon, dashed path, even-odd, arc, line, polyline
  assert.equal(model.firstTypes.image, 1);
  assert.equal(model.firstTypes.group, 3); // transformed g and two use wrappers
  assert.ok(model.evenodd && model.dashed);
  assert.deepEqual(model.firstWarnings, [], "supported fixture imports without warnings");
  // Browser SVG raster of the original vs. the editor's export; CanvasKit
  // vs. that export uses the same 1.5 mean bound as the renderer pixel suite.
  for (const [name, result, mean, over] of [
    ["once", model.exportedOnce, 0.1, 0.001],
    ["twice", model.exportedTwice, 0.1, 0.001],
    ["canvasKit", model.canvasKit, 1.5, 0.005],
  ]) {
    assert.ok(result.meanAbsoluteChannelError < mean, `${name} mean ${result.meanAbsoluteChannelError}`);
    assert.ok(result.pixelsOver64 < over, `${name} pixels over 64: ${result.pixelsOver64}`);
  }
  report.checks.push("supported subset: types, no warnings, import→export and second round trip pixel parity, CanvasKit parity");
  for (const expected of [
    "script는 실행하지 않고 제외했습니다",
    "CSS @import는 불러오지 않습니다",
    "지원하지 않는 CSS 선택자: g rect",
    "clip-path 잘라내기는 적용하지 않습니다",
    "filter 효과는 적용하지 않습니다",
    "pattern 등 gradient가 아닌 채우기는 대체 색으로 그립니다",
    "선 끝·모서리 모양(linecap, linejoin)은 기본값으로 그립니다",
    "외부 이미지(파일·URL 참조)는 가져오지 않습니다",
    "foreignObject(HTML 내용)는 가져오지 않습니다",
    "애니메이션은 가져오지 않습니다",
    "중첩 svg의 영역 잘라내기는 적용하지 않습니다",
    "tspan별로 다른 글꼴·색은 텍스트 전체의 첫 스타일로 통일합니다",
    "외부 파일을 가리키는 use는 가져오지 않습니다",
  ])
    assert.ok(model.unsafeWarnings.includes(expected), `warning: ${expected}`);
  assert.equal(model.unsafeTypes.text, 1);
  report.checks.push("unsupported/unsafe features: warned, not executed, not fetched");
  const [middle, lines] = model.texts;
  assert.equal(middle.content, "가운데 Middle");
  assert.equal(middle.align, "center");
  assert.ok(Math.abs(middle.x + middle.width / 2 - 100) < 0.01, "text-anchor middle centred on x");
  assert.ok(Math.abs(middle.y - (40 - 20)) < 0.01, "baseline placed at y");
  assert.equal(lines.content, "First line\nSecond line");
  assert.equal(lines.lineHeight, 20);
  assert.equal(lines.fontWeight, 700);
  report.checks.push("text: anchor, baseline, tspan lines and weight");
  assert.deepEqual(model.jpegAsset, [["image/png", 8, 4, "data:image/png;base64,"]]);
  assert.equal(model.rejected, "올바른 SVG 파일이 아닙니다.");
  report.checks.push("JPEG data image converted to owned PNG; non-SVG rejected");
  const e = model.edge;
  assert.deepEqual(e.symbolFill, { type: "solid", color: "#ff0000" }, "symbol style cascades");
  const [centre, tspanX] = e.texts;
  assert.equal(centre.content, "Centre\nnext");
  assert.equal(centre.lineHeight, 12, "dy=1.2em with font-size 10");
  assert.ok(Math.abs(centre.x + centre.width / 2 - 100) < 0.01, "x=50% centred");
  assert.equal(tspanX.x, 30, "leading tspan x wins");
  assert.equal(e.texts.length, 2, "font-size 0 text skipped");
  assert.equal(e.paths, 0, "oversized path skipped");
  assert.equal(e.rectangles, 2, "non-finite gradient element skipped; symbol rect and teal rect kept");
  assert.ok(e.warnings.includes("글자 크기가 0 이하인 텍스트는 제외했습니다"));
  assert.ok(e.warnings.some((w) => w.startsWith("범위를 벗어나거나 잘못된 값이 있는 요소는 제외했습니다")));
  report.checks.push("edge values: symbol styles, unit text positions, invalid elements skipped without failing");

  // Real editor: upload through the toolbar, one Undo step, autosave reload.
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector('[data-testid="save-status"]').dataset.state !== "loading");
  const exportedJson = async () => {
    const d = page.waitForEvent("download");
    await page.getByRole("button", { name: "JSON 저장", exact: true }).click();
    const chunks = [];
    for await (const c of await (await d).createReadStream()) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString());
  };
  const saved = () =>
    page.waitForFunction(() => document.querySelector('[data-testid="save-status"]').dataset.state === "saved");
  const before = await exportedJson();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "SVG 가져오기" }).click();
  await (await chooser).setFiles({ name: "badge.svg", mimeType: "image/svg+xml", buffer: Buffer.from(shapes) });
  await page.getByText("SVG를 가져왔습니다").waitFor();
  await saved();
  const after = await exportedJson();
  const added = Object.values(after.nodes).filter((n) => !before.nodes[n.id]);
  assert.equal(added.length, 18);
  const frame = added.find((n) => n.type === "frame");
  assert.equal(frame.name, "badge");
  assert.equal(frame.parentId, after.rootId);
  assert.equal(Object.keys(after.assets).length, Object.keys(before.assets).length + 1);
  assert.ok(await page.getByTestId(`layer-${frame.id}`).evaluate((el) => el.classList.contains("selected")));
  await page.keyboard.press("Meta+z");
  await saved();
  assert.deepEqual((await exportedJson()).nodes, before.nodes, "import is one Undo step");
  await page.keyboard.press("Meta+Shift+z");
  await saved();
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector('[data-testid="save-status"]').dataset.state === "saved");
  assert.deepEqual((await exportedJson()).nodes, after.nodes, "autosave keeps imported nodes");
  await page.getByLabel("렌더러 선택").selectOption("canvaskit");
  await page.waitForFunction(() => document.querySelector(".renderer-surface canvas"));
  await page.waitForTimeout(500);
  assert.equal(await page.getByText("렌더러 오류").count(), 0);
  await page.screenshot({ path: artifactPath("i01-editor-canvaskit.png") });
  report.checks.push("editor: toolbar upload, selection, one-step Undo/Redo, autosave reload, CanvasKit renders");
  assert.deepEqual(errors, []);
  await fs.writeFile(artifactPath("i01-svg-import.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(report.checks.map((c) => `PASS ${c}`).join("\n"));
} finally {
  await browser.close();
}
