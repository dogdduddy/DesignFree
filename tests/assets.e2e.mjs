import { serverTestUrl, browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { authenticatedTestSession } from "./auth-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
const url = serverTestUrl();
const project = process.env.COMPOSE_PROJECT;
assert.ok(
  /^(designfree-test-|draftroom-test-)/.test(project || ""),
  "This asset suite requires a disposable designfree-test- or draftroom-test- COMPOSE_PROJECT",
);
const docker = (args) =>
  execFileSync("docker", ["compose", "-p", project, ...args], {
    encoding: "utf8",
  });
const auth = await authenticatedTestSession(url);
const api = auth.fetch;
const load = async () => {
  const r = await api("/api/library/current");
  assert.equal(r.status, 200);
  return r.json();
};
const save = async (library) => {
  const current = await load();
  const r = await api("/api/library/current", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      document: library.document,
      documents: library.documents,
      expectedVersion: current?.version ?? 0,
      operationId: randomUUID(),
    }),
  });
  assert.equal(r.status, 200, await r.text());
};
const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({
    storageState: auth.storageState,
    viewport: { width: 1440, height: 1000 },
  }),
  checks = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const baseline = await load();
let movedPath;
const ready = () =>
  page.waitForFunction(() =>
    ["saved", "idle"].includes(
      document.querySelector('[data-testid="save-status"]')?.dataset.state,
    ),
  );
const check = async (name, run) => {
  await run();
  checks.push(name);
  console.log("PASS " + name);
};
try {
  await page.goto(url, { waitUntil: "networkidle" });
  await ready();
  await page.locator(".document-library summary").click();
  await page.getByRole("button", { name: "새 문서", exact: true }).click();
  await ready();
  const png = Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 32;
      c.height = 24;
      const g = c.getContext("2d");
      g.fillStyle = "#2188ef";
      g.fillRect(0, 0, 32, 24);
      return c.toDataURL("image/png").split(",")[1];
    }),
    "base64",
  );
  await check(
    "invalid PNG upload preserves the document and shows failure",
    async () => {
      const before = await load();
      await page.locator('input[accept="image/png"]').setInputFiles({
        name: "broken.png",
        mimeType: "image/png",
        buffer: Buffer.from("invalid PNG"),
      });
      await page
        .getByText(
          "이미지를 읽을 수 없습니다. 올바른 PNG 파일인지 확인해 주세요.",
          { exact: true },
        )
        .waitFor();
      assert.deepEqual(await load(), before);
    },
  );
  let record, assetId, docId, assetURL, key;
  await check(
    "native upload failure retains memory image, retry commits volume bytes and JSONB digest references",
    async () => {
      const beforeUpload = await load();
      await page.route("**/api/library/current", (route) =>
        route.request().method() === "PUT"
          ? route.fulfill({
              status: 503,
              contentType: "application/json",
              body: '{"error":"injected_upload_failure"}',
            })
          : route.continue(),
      );
      await page.locator('input[accept="image/png"]').setInputFiles({
        name: "H02-upload.png",
        mimeType: "image/png",
        buffer: png,
      });
      await page
        .getByTestId("asset-status")
        .filter({ hasText: "이미지 1개" })
        .waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="save-status"]')?.dataset
            .state === "error",
      );
      assert.equal(
        await page.getByTestId("asset-status").getAttribute("data-state"),
        "unconfirmed",
      );
      assert.deepEqual(await load(), beforeUpload);
      await page.unroute("**/api/library/current");
      await page
        .getByRole("button", { name: "저장 재시도", exact: true })
        .click();
      await ready();
      record = await load();
      docId = record.document.id;
      assetId = Object.keys(record.document.assets)[0];
      assert.equal(
        record.document.assets[assetId].dataUrl,
        "data:image/png;base64," + png.toString("base64"),
      );
      const stored = docker([
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "draftroom",
        "-d",
        "draftroom",
        "-Atc",
        "SELECT payload::text FROM draftroom_library WHERE id=1",
      ]);
      assert.ok(!stored.includes("data:image/png"));
      assert.ok(stored.includes("blobKey"));
      assetURL = `/api/documents/${encodeURIComponent(docId)}/assets/${encodeURIComponent(assetId)}`;
      const r = await api(assetURL);
      assert.equal(r.status, 200);
      assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
      key = createHash("sha256").update(png).digest("hex");
    },
  );
  await check(
    "document-scoped lookup rejects another document, guessed digest and traversal",
    async () => {
      const other = structuredClone(record.document);
      other.id = "h02-other-document";
      const otherAsset = "h02-other-asset";
      other.assets = {
        [otherAsset]: { ...other.assets[assetId], id: otherAsset },
      };
      for (const node of Object.values(other.nodes))
        if (node.assetId === assetId) node.assetId = otherAsset;
      await save({
        document: record.document,
        documents: [...record.documents, other],
      });
      assert.equal(
        (await api(`/api/documents/${other.id}/assets/${otherAsset}`)).status,
        200,
      );
      for (const path of [
        `/api/documents/${encodeURIComponent(docId)}/assets/${otherAsset}`,
        `/api/documents/${other.id}/assets/${assetId}`,
        `/api/documents/other-document/assets/${assetId}`,
        `/api/documents/${encodeURIComponent(docId)}/assets/${key}`,
        `/api/documents/${encodeURIComponent(docId)}/assets/%2E%2E%2F${assetId}`,
      ])
        assert.equal((await api(path)).status, 404);
      assert.equal(
        (
          await api("/api/assets/cleanup", {
            method: "POST",
            headers: { "sec-fetch-site": "cross-site" },
          })
        ).status,
        403,
      );
    },
  );
  await check(
    "fresh reload and portable JSON export retain uploaded PNG",
    async () => {
      await page.reload({ waitUntil: "networkidle" });
      await ready();
      assert.match(
        await page.getByTestId("asset-status").textContent(),
        /이미지 1개/,
      );
      const downloadPromise = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "JSON 저장", exact: true })
        .click();
      const chunks = [];
      for await (const chunk of await (
        await downloadPromise
      ).createReadStream())
        chunks.push(chunk);
      const exported = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(
        exported.assets[assetId].dataUrl,
        record.document.assets[assetId].dataUrl,
      );
    },
  );
  await check(
    "missing volume bytes produce explicit status and renderable placeholder without losing digest",
    async () => {
      const directory = createHash("sha256").update(docId).digest("hex");
      movedPath = `/app/asset-data/${directory}/${key}.png`;
      docker([
        "exec",
        "-T",
        "api",
        "node",
        "-e",
        `require('fs').renameSync(${JSON.stringify(movedPath)},${JSON.stringify(movedPath + ".h02-backup")})`,
      ]);
      assert.equal((await api(assetURL)).status, 404);
      await page.reload({ waitUntil: "networkidle" });
      await ready();
      await page
        .getByTestId("asset-status")
        .filter({ hasText: "이미지 누락 1개" })
        .waitFor();
      const missing = await load();
      assert.equal(missing.document.assets[assetId].missing, key);
      const decoded = await page.evaluate(async (data) => {
        const i = new Image();
        i.src = data;
        await i.decode();
        return i.naturalWidth;
      }, missing.document.assets[assetId].dataUrl);
      assert.equal(decoded, 16);
      await save(missing);
      assert.equal((await api(assetURL)).status, 404);
      const reread = await load();
      assert.equal(reread.document.assets[assetId].missing, key);
      await page.screenshot({
        path: process.env.ASSET_SCREENSHOT || artifactPath("104-h02-missing-preview.png"),
      });
    },
  );
  await check(
    "restored bytes recover original image and clear missing state",
    async () => {
      docker([
        "exec",
        "-T",
        "api",
        "node",
        "-e",
        `require('fs').renameSync(${JSON.stringify(movedPath + ".h02-backup")},${JSON.stringify(movedPath)})`,
      ]);
      movedPath = undefined;
      await page.reload({ waitUntil: "networkidle" });
      await ready();
      assert.match(
        await page.getByTestId("asset-status").textContent(),
        /이미지 1개/,
      );
      assert.equal((await load()).document.assets[assetId].missing, undefined);
    },
  );
  await check(
    "clean API and editor recreation preserves asset volume and bytes",
    async () => {
      const before = docker(["ps", "-q", "api"]).trim();
      docker(["up", "-d", "--force-recreate", "--no-build", "api", "editor"]);
      for (let i = 0; i < 30; i++) {
        try {
          if ((await api("/api/health")).ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 250));
      }
      const after = docker(["ps", "-q", "api"]).trim();
      assert.notEqual(before, after);
      const r = await api(assetURL);
      assert.equal(r.status, 200);
      assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
      await page.reload({ waitUntil: "networkidle" });
      await ready();
      assert.match(
        await page.getByTestId("asset-status").textContent(),
        /이미지 1개/,
      );
    },
  );
  await check(
    "cleanup retains current assets and starts a seven-day orphan grace after document removal",
    async () => {
      assert.equal(
        (await api("/api/assets/cleanup", { method: "POST" })).status,
        200,
      );
      if (baseline) await save(baseline);
      const r = await api("/api/assets/cleanup", { method: "POST" });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).graceDays, 7);
      // The removed document is inaccessible even while its bytes remain quarantined.
      if (baseline) assert.equal((await api(assetURL)).status, 404);
    },
  );
  assert.deepEqual(errors, []);
} finally {
  if (movedPath)
    docker([
      "exec",
      "-T",
      "api",
      "node",
      "-e",
      `require('fs').renameSync(${JSON.stringify(movedPath + ".h02-backup")},${JSON.stringify(movedPath)})`,
    ]);
  if (baseline) await save(baseline);
  await fs.writeFile(
    process.env.ASSET_REPORT || artifactPath("100-h02-assets-browser.json"),
    JSON.stringify(
      { url, checks, passed: checks.length, pageErrors: errors },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
}
