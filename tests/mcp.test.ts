import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { createApi } from "../server/http";
import { handleRpc, MCP_PROTOCOL_VERSIONS, tools, type McpLibrary } from "../server/mcp";
import { tokenName, verifyBearer } from "../server/tokens";
import { createDemoDocument, createNode } from "../src/core";

function library(): McpLibrary {
  const doc = createDemoDocument();
  const page = doc.nodes[doc.rootId];
  const screen = createNode("frame", page.id, { id: "screen-a", name: "Home screen", width: 300, height: 500, children: ["hello", "go"] });
  const hello = createNode("text", "screen-a", { id: "hello", name: "Greeting", text: { content: "Hello 안녕", fontFamily: "Noto Sans KR", fontSize: 18, fontWeight: 700, lineHeight: 24 } });
  const go = createNode("rectangle", "screen-a", { id: "go", name: "Go button", interactions: [{ trigger: "click", action: { type: "navigate", destinationId: "screen-b", transition: { type: "instant" } } }] });
  const other = createNode("frame", page.id, { id: "screen-b", name: "Detail screen", width: 300, height: 500 });
  Object.assign(doc.nodes, { "screen-a": screen, hello, go, "screen-b": other });
  page.children.push("screen-a", "screen-b");
  page.prototypeStartId = "screen-a";
  const second = createDemoDocument();
  second.id = "second-doc";
  second.name = "Second";
  return { document: doc, documents: [second], version: 7, updatedAt: "2026-11-02T00:00:00.000Z" };
}
const call = async (name: string, args: Record<string, unknown> = {}, lib: McpLibrary | null = library()) => {
  const reply = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { load: async () => lib })) as any;
  const content = reply.result.content[0].text as string;
  let data = null;
  try {
    data = reply.result.isError ? null : JSON.parse(content);
  } catch {}
  return { reply, isError: !!reply.result.isError, text: content, data };
};

describe("MCP protocol", () => {
  it("negotiates a supported protocol version and advertises read-only tools", async () => {
    const init = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, { load: async () => null })) as any;
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.capabilities).toEqual({ tools: { listChanged: false } });
    const unknown = (await handleRpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, { load: async () => null })) as any;
    expect(unknown.result.protocolVersion).toBe(MCP_PROTOCOL_VERSIONS[0]);
    const list = (await handleRpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { load: async () => null })) as any;
    expect(list.result.tools.map((t: any) => t.name)).toEqual(tools.map((t) => t.name));
    for (const t of list.result.tools) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.inputSchema.type).toBe("object");
    }
  });
  it("answers ping, ignores notifications and rejects unknown methods and malformed messages", async () => {
    expect(await handleRpc({ jsonrpc: "2.0", id: 9, method: "ping" }, { load: async () => null })).toEqual({ jsonrpc: "2.0", id: 9, result: {} });
    expect(await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { load: async () => null })).toBeUndefined();
    expect(((await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/write" }, { load: async () => null })) as any).error.code).toBe(-32601);
    expect(((await handleRpc({ id: 1, method: "ping" }, { load: async () => null })) as any).error.code).toBe(-32600);
    expect(((await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } }, { load: async () => null })) as any).error.code).toBe(-32602);
  });
});

describe("read-only design tools", () => {
  it("lists documents with pages and screens", async () => {
    const { data } = await call("list_documents");
    expect(data.libraryVersion).toBe(7);
    expect(data.documents.map((d: any) => d.id)).toContain("second-doc");
    const first = data.documents[0];
    expect(first.activeInEditor).toBe(true);
    expect(first.pages[0].screens.map((s: any) => s.name).slice(-2)).toEqual(["Home screen", "Detail screen"]);
  });
  it("returns a bounded outline and full node details", async () => {
    const lib = library();
    const { data } = await call("get_outline", { documentId: lib.document.id, nodeId: "screen-a" }, lib);
    expect(data.tree.name).toBe("Home screen");
    expect(data.tree.children.map((c: any) => c.id)).toEqual(["hello", "go"]);
    expect(data.tree.children[0].text).toBe("Hello 안녕");
    expect(data.tree.children[1].linksTo).toEqual(["screen-b"]);
    const small = (await call("get_outline", { documentId: lib.document.id, maxNodes: 3 }, lib)).data;
    expect(small.truncated).toBe(true);
    expect(small.nodeCount).toBeLessThanOrEqual(3);
    const nodes = (await call("get_nodes", { documentId: lib.document.id, nodeIds: ["go", "missing"] }, lib)).data.nodes;
    expect(nodes[0]).toMatchObject({ id: "go", type: "rectangle", path: expect.stringContaining("Home screen"), childIds: [] });
    expect(nodes[0].worldBox).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(nodes[1]).toEqual({ id: "missing", error: "not found" });
  });
  it("never returns image bytes in node details", async () => {
    const lib = library();
    const image = Object.values(lib.document.nodes).find((n) => n.type === "image")!;
    const { text } = await call("get_nodes", { documentId: lib.document.id, nodeIds: [image.id] }, lib);
    expect(text).not.toContain("base64");
    expect(JSON.parse(text).nodes[0].asset).toMatchObject({ id: image.assetId });
  });
  it("searches names and text, extracts text, styles, components and prototype links", async () => {
    const lib = library();
    const search = (await call("search_layers", { query: "안녕" }, lib)).data;
    expect(search.matches.map((m: any) => m.id)).toEqual(["hello"]);
    expect((await call("search_layers", { query: "screen", type: "frame" }, lib)).data.total).toBe(2);
    const texts = (await call("get_text_content", { documentId: lib.document.id, nodeId: "screen-a" }, lib)).data;
    expect(texts.texts).toEqual([expect.objectContaining({ id: "hello", screen: "Home screen", fontWeight: 700 })]);
    const styles = (await call("get_styles", { documentId: lib.document.id }, lib)).data;
    expect(styles).toHaveProperty("tokens");
    for (const t of styles.tokens) expect(t).toHaveProperty("referencedByStyles");
    for (const st of styles.styles) expect(st).toHaveProperty("usedByLayers");
    expect((await call("get_components", { documentId: lib.document.id }, lib)).data).toHaveProperty("components");
    const proto = (await call("get_prototype", { documentId: lib.document.id }, lib)).data;
    expect(proto.startScreenId).toBe("screen-a");
    expect(proto.links).toEqual([expect.objectContaining({ sourceId: "go", destinationId: "screen-b", destination: "Detail screen" })]);
  });
  it("exports a subtree as raw SVG text with image placeholders by default", async () => {
    const lib = library();
    const svg = (await call("export_svg", { documentId: lib.document.id, nodeId: "screen-a" }, lib)).text;
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="300" height="500"');
    expect(svg).toContain("Hello 안녕");
    const page = (await call("export_svg", { documentId: lib.document.id, nodeId: lib.document.rootId }, lib)).text;
    const original = Object.values(lib.document.assets)[0].dataUrl;
    expect(page).not.toContain(original);
  });
  it("reads only the exported layers' stored images when includeImages is set", async () => {
    const lib = library();
    const [assetId, asset] = Object.entries(lib.document.assets)[0];
    // Stored form on the server: metadata plus a blob key, no data URL.
    lib.document.assets[assetId] = { ...asset, dataUrl: undefined, blobKey: "a".repeat(64) } as never;
    lib.document.assets.unused = { ...asset, id: "unused", dataUrl: undefined, blobKey: "b".repeat(64) } as never;
    const reads: string[] = [];
    const readImage = async (_doc: string, key: string) => {
      reads.push(key);
      return Buffer.from(asset.dataUrl.split(",")[1], "base64");
    };
    const reply = (await handleRpc(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "export_svg", arguments: { documentId: lib.document.id, nodeId: lib.document.rootId, includeImages: true } } },
      { load: async () => lib, readImage },
    )) as any;
    expect(reads).toEqual(["a".repeat(64)]);
    expect(reply.result.content[0].text).toContain(asset.dataUrl);
  });
  it("treats prototype property names as unknown ids and unexpected failures as tool errors", async () => {
    const lib = library();
    for (const id of ["constructor", "toString", "__proto__"]) {
      expect((await call("get_outline", { documentId: lib.document.id, nodeId: id }, lib)).isError).toBe(true);
      expect((await call("export_svg", { documentId: lib.document.id, nodeId: id }, lib)).isError).toBe(true);
      expect((await call("get_nodes", { documentId: lib.document.id, nodeIds: [id] }, lib)).data.nodes[0].error).toBe("not found");
    }
    // A broken stored document must not turn into an HTTP failure.
    const broken = library();
    delete broken.document.assets[Object.keys(broken.document.assets)[0]];
    const failure = await call("export_svg", { documentId: broken.document.id, nodeId: broken.document.rootId, includeImages: true }, broken);
    expect(failure.isError).toBe(true);
    expect(failure.text).toContain("export_svg failed");
    const hidden = library();
    hidden.document.nodes.hello.visible = false;
    expect((await call("export_svg", { documentId: hidden.document.id, nodeId: "hello" }, hidden)).isError).toBe(true);
  });
  it("reports tool errors as results, not protocol failures", async () => {
    const missing = await call("get_outline", { documentId: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("No document");
    expect((await call("list_documents", {}, null)).isError).toBe(true);
    expect((await call("search_layers", { query: " " })).isError).toBe(true);
  });
});

describe("tokens and the MCP HTTP endpoint", () => {
  it("validates token names and bearer format before touching the database", async () => {
    expect(tokenName({ name: " Claude " })).toBe("Claude");
    for (const bad of [{}, { name: "" }, { name: "x".repeat(81) }, null]) expect(() => tokenName(bad)).toThrow();
    const query = vi.fn();
    for (const header of [undefined, "Basic abc", "Bearer short", "Bearer dft_" + "x".repeat(10), "Bearer abc_" + "x".repeat(40)])
      expect(await verifyBearer({ query } as unknown as Pool, header)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
  it("requires a valid token, accepts only POST and replies 202 to notifications", async () => {
    const token = "dft_" + "a".repeat(43);
    const digest = createHash("sha256").update(token).digest("hex");
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM draftroom_api_tokens WHERE token_hash"))
        return { rows: params?.[0] === digest ? [{ id: "t1", scope: "read", last_used_at: new Date().toISOString() }] : [] };
      if (sql.includes("FROM draftroom_library")) return { rows: [] };
      return { rows: [] };
    });
    const server = createApi({ query } as unknown as Pool);
    const send = async (method: string, headers: Record<string, string>, body?: unknown) => {
      const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { url: "/api/mcp", method, headers });
      let status = 0, out = "";
      const res = { setHeader: vi.fn(), writeHead: (c: number) => (status = c), end: (v?: string) => (out = v ?? ""), headersSent: false };
      await (server.listeners("request")[0] as Function)(req, res);
      return { status, body: out ? JSON.parse(out) : null, headers: res.setHeader.mock.calls };
    };
    const json = { "content-type": "application/json" };
    const missing = await send("POST", json, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(missing.status).toBe(401);
    expect(missing.headers).toContainEqual(["WWW-Authenticate", 'Bearer realm="designfree"']);
    expect((await send("POST", { ...json, authorization: "Bearer dft_" + "b".repeat(43) }, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    const auth = { ...json, authorization: `Bearer ${token}` };
    expect(await send("POST", auth, { jsonrpc: "2.0", id: 1, method: "ping" })).toMatchObject({ status: 200, body: { id: 1, result: {} } });
    expect((await send("GET", { authorization: `Bearer ${token}` })).status).toBe(405);
    expect((await send("POST", auth, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const batch = await send("POST", auth, [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]);
    expect(batch.body).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
    expect((await send("POST", auth, [])).body.error.code).toBe(-32600);
    expect((await send("POST", auth, Array.from({ length: 11 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" })))).body.error.code).toBe(-32600);
    // Trailing slash or query still reaches the endpoint; scheme is case-insensitive.
    const alias = async (u: string) => {
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }))]), { url: u, method: "POST", headers: { ...json, authorization: `bearer ${token}` } });
      let status = 0;
      await (server.listeners("request")[0] as Function)(req, { setHeader: vi.fn(), writeHead: (c: number) => (status = c), end: () => {}, headersSent: false });
      return status;
    };
    expect(await alias("/api/mcp/")).toBe(200);
    expect(await alias("/api/mcp?x=1")).toBe(200);
    // A browser page from another origin cannot use the endpoint.
    expect((await send("POST", { ...auth, origin: "http://evil.example" , host: "designfree.local" }, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(403);
    // The browser session cookie is not an MCP credential.
    expect((await send("POST", { ...json, cookie: "draftroom_session=abc" }, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
  });
});
