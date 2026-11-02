import { browserLaunchOptions, artifactPath, serverTestUrl } from "./browser-helpers.mjs";
import { authenticatedTestSession } from "./auth-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Read-only MCP against a disposable server: create a token in the editor,
// call every tool over HTTP, check images come from the asset volume, then
// revoke. MCP_SDK_DIR (optional) also runs the official MCP SDK client.
const url = serverTestUrl();
const auth = await authenticatedTestSession(url);
const endpoint = new URL("/api/mcp", url).href;
const checks = [];
const report = {};
const check = (name) => {
  checks.push(name);
  console.log(`PASS mcp: ${name}`);
};
// A 1×1 PNG distinct from the placeholder, so export_svg can be checked
// against the stored asset bytes.
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const node = (type, id, parentId, props = {}) => ({
  id, type, name: props.name ?? id, parentId, children: [], transform: [1, 0, 0, 1, 0, 0],
  width: 100, height: 100, fill: { type: "solid", color: "#cfd6ee" }, opacity: 1, radius: 0,
  clipContent: false, visible: true, locked: false, layout: { mode: "absolute" }, ...props,
});
const fixture = {
  schemaVersion: 1, id: "mcp-fixture", name: "MCP fixture", rootId: "page",
  nodes: {
    page: node("page", "page", null, { name: "Page", width: 800, height: 600, children: ["login", "home"], prototypeStartId: "login" }),
    login: node("frame", "login", "page", { name: "Login", width: 300, height: 500, fill: { type: "solid", color: "#ffffff" }, children: ["title", "logo", "submit"] }),
    title: node("text", "title", "login", { name: "Title", transform: [1, 0, 0, 1, 20, 20], width: 200, height: 30, fill: { type: "solid", color: "#222222" }, text: { content: "다시 오신 걸 환영해요", fontFamily: "Noto Sans KR", fontSize: 20, fontWeight: 700, lineHeight: 30 } }),
    logo: node("image", "logo", "login", { name: "Logo", transform: [1, 0, 0, 1, 20, 80], width: 16, height: 16, fill: { type: "none" }, assetId: "logo-png" }),
    submit: node("rectangle", "submit", "login", { name: "Submit button", transform: [1, 0, 0, 1, 20, 400], width: 260, height: 48, interactions: [{ trigger: "click", action: { type: "navigate", destinationId: "home", transition: { type: "dissolve", duration: 300 } } }] }),
    home: node("frame", "home", "page", { name: "Home", transform: [1, 0, 0, 1, 400, 0], width: 300, height: 500 }),
  },
  assets: { "logo-png": { id: "logo-png", mimeType: "image/png", dataUrl: png, width: 1, height: 1 } },
};

const rpc = async (token, body, extra = {}) => {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: r.status === 202 ? null : await r.json() };
};
const tool = async (token, name, args = {}) => {
  const { body } = await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  assert.ok(!body.result.isError, `${name}: ${body.result.content[0].text}`);
  const text = body.result.content[0].text;
  return name === "export_svg" ? text : JSON.parse(text);
};

const browser = await chromium.launch(browserLaunchOptions());
try {
  const page = await browser.newPage({ storageState: auth.storageState, viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator('input[type=file][accept="application/json,.json"]').setInputFiles({
    name: "mcp.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="save-status"]').dataset.state === "saved");

  // Without a token nothing is readable; the browser session cookie is not enough.
  assert.equal((await rpc(null, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401);
  const cookie = auth.storageState.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  assert.equal((await rpc(null, { jsonrpc: "2.0", id: 1, method: "ping" }, { cookie })).status, 401);

  // Create a token in the editor dialog (with a layer selected, so a leaked
  // Delete shortcut would show up as a library change at the end).
  await page.getByTestId("layer-title").locator(".layer-name").click();
  await page.getByRole("button", { name: "AI 연결" }).click();
  const dialog = page.getByRole("dialog", { name: "AI 도구 연결" });
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => document.querySelector(".editor-app").inert), true);
  await dialog.getByLabel("토큰 이름").fill("E2E Claude Code");
  await dialog.getByRole("button", { name: "토큰 만들기" }).click();
  const token = (await page.getByTestId("ai-token-value").textContent()).trim();
  assert.match(token, /^dft_[A-Za-z0-9_-]{43}$/);
  assert.ok((await dialog.locator("pre").first().textContent()).includes(token), "snippet carries the new token");
  assert.ok((await dialog.locator("pre").first().textContent()).includes(endpoint));
  check("token created in the editor; snippets carry endpoint and token; cookie alone is rejected");

  // Protocol.
  const init = await rpc(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } });
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.equal((await rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const list = await rpc(token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(list.body.result.tools.length, 9);
  assert.ok(list.body.result.tools.every((t) => t.annotations.readOnlyHint));

  // Tools against the stored library.
  const docs = await tool(token, "list_documents");
  const doc = docs.documents.find((d) => d.id === "mcp-fixture");
  assert.deepEqual(doc.pages[0].screens.map((s) => s.name), ["Login", "Home"]);
  const outline = await tool(token, "get_outline", { documentId: doc.id, nodeId: "login" });
  assert.deepEqual(outline.tree.children.map((c) => c.id), ["title", "logo", "submit"]);
  const details = await tool(token, "get_nodes", { documentId: doc.id, nodeIds: ["submit", "logo"] });
  assert.equal(details.nodes[0].interactions[0].action.destinationId, "home");
  assert.equal(details.nodes[1].asset.width, 1);
  assert.ok(!JSON.stringify(details).includes("base64"), "no image bytes in details");
  assert.equal((await tool(token, "search_layers", { query: "환영" })).matches[0].id, "title");
  assert.equal((await tool(token, "get_text_content", { documentId: doc.id })).texts[0].content, "다시 오신 걸 환영해요");
  assert.equal((await tool(token, "get_prototype", { documentId: doc.id })).startScreenId, "login");
  await tool(token, "get_styles", { documentId: doc.id });
  await tool(token, "get_components", { documentId: doc.id });
  const placeholder = await tool(token, "export_svg", { documentId: doc.id, nodeId: "login" });
  assert.ok(placeholder.includes('width="300" height="500"') && !placeholder.includes(png), "placeholder image by default");
  const full = await tool(token, "export_svg", { documentId: doc.id, nodeId: "login", includeImages: true });
  assert.ok(full.includes(png), "includeImages reads the stored PNG from the asset volume");
  // OAuth discovery probes get a plain 404, not the editor page.
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/api/mcp"])
    assert.equal((await fetch(new URL(path, url))).status, 404, path);
  check("initialize, tools/list and all 9 tools read the stored library; images only on request; no OAuth discovery");

  // Optional: the official MCP TypeScript SDK client.
  if (process.env.MCP_SDK_DIR) {
    const sdk = (p) => import(pathToFileURL(`${process.env.MCP_SDK_DIR}/node_modules/@modelcontextprotocol/sdk/dist/esm/${p}`).href);
    const { Client } = await sdk("client/index.js");
    const { StreamableHTTPClientTransport } = await sdk("client/streamableHttp.js");
    const client = new Client({ name: "designfree-e2e", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const sdkTools = await client.listTools();
    assert.equal(sdkTools.tools.length, 9);
    const sdkCall = await client.callTool({ name: "search_layers", arguments: { query: "Submit" } });
    assert.ok(sdkCall.content[0].text.includes("Submit button"));
    await client.close();
    report.sdk = { version: JSON.parse(await fs.readFile(`${process.env.MCP_SDK_DIR}/node_modules/@modelcontextprotocol/sdk/package.json`, "utf8")).version, server: client.getServerVersion?.() ?? null };
    check(`official MCP SDK ${report.sdk.version} client connects, lists and calls tools`);
  }

  // Revoke in the editor: the token stops working immediately.
  // The editor ignores shortcuts while the dialog is open (Delete would remove a layer).
  await dialog.getByRole("button", { name: "토큰 복사" }).focus();
  await page.keyboard.press("Delete");
  await page.keyboard.press("Meta+z");
  page.once("dialog", (d) => d.accept());
  await dialog.getByRole("listitem").filter({ hasText: "E2E Claude Code" }).getByRole("button", { name: "폐기" }).click();
  await dialog.getByText("아직 만든 토큰이 없습니다.").waitFor();
  assert.equal((await rpc(token, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401);
  await dialog.getByRole("button", { name: "AI 연결 닫기" }).click();
  check("revoking in the editor blocks the token at once");

  // Reading through MCP changed nothing.
  const lib = await (await auth.fetch("/api/library/current")).json();
  assert.deepEqual([lib.document, ...lib.documents].find((d) => d.id === "mcp-fixture").nodes, fixture.nodes);
  check("library unchanged by MCP reads");
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
await fs.writeFile(artifactPath("mcp-server.json"), JSON.stringify({ checks, ...report }, null, 2) + "\n");
