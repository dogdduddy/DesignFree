import {
  getWorldTransform,
  transformPoint,
  type SceneDocument,
  type SceneNode,
} from "../src/core";
import { computeLayout } from "../src/flex-layout";
import { resolveDocumentStyles } from "../src/style-library";
import { exportSvg } from "../src/renderers/svg";
import { MISSING_PNG } from "../src/assets";
import { isScreen, screens } from "../src/prototype";

/** Model Context Protocol over Streamable HTTP (stateless JSON responses),
 * exposing read-only design tools. Spec: modelcontextprotocol.io. */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export type McpLibrary = {
  document: SceneDocument;
  documents: SceneDocument[];
  version?: number;
  updatedAt?: string;
};
type Json = Record<string, unknown>;
/** Per-request access: the library is loaded once; PNG bytes on demand. */
export type McpContext = {
  load: () => Promise<McpLibrary | null>;
  readImage?: (documentId: string, blobKey: string) => Promise<Buffer>;
};
/** A tool result that is already the text to return (SVG markup). */
class RawText {
  constructor(readonly text: string) {}
}
const MAX_SVG = 2_000_000;
type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
const MAX_TEXT = 200_000;

class ToolError extends Error {}
const fail = (message: string): never => {
  throw new ToolError(message);
};

// ---------- helpers ----------

const allDocuments = (lib: McpLibrary) => [lib.document, ...lib.documents];
// Own properties only: ids such as "constructor" must not match prototypes.
const has = (doc: SceneDocument, id: unknown): id is string => typeof id === "string" && Object.hasOwn(doc.nodes, id);
function documentById(lib: McpLibrary, id: unknown) {
  if (typeof id !== "string" || !id) fail("documentId is required (see list_documents).");
  return allDocuments(lib).find((d) => d.id === id) ?? fail(`No document with id ${id}.`);
}
const pagesOf = (doc: SceneDocument) => doc.pageIds ?? [doc.rootId];
function pageOfNode(doc: SceneDocument, id: string) {
  let n: SceneNode | undefined = doc.nodes[id];
  while (n?.parentId) n = doc.nodes[n.parentId];
  return n?.id;
}
const round = (v: number) => Math.round(v * 100) / 100;
function box(doc: SceneDocument, id: string) {
  const n = doc.nodes[id];
  const m = getWorldTransform(doc, id);
  const pts = [
    { x: 0, y: 0 },
    { x: n.width, y: 0 },
    { x: 0, y: n.height },
    { x: n.width, y: n.height },
  ].map((p) => transformPoint(m, p));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return {
    x: round(Math.min(...xs)),
    y: round(Math.min(...ys)),
    width: round(Math.max(...xs) - Math.min(...xs)),
    height: round(Math.max(...ys) - Math.min(...ys)),
  };
}
function pathOf(doc: SceneDocument, id: string) {
  const names: string[] = [];
  for (let n: SceneNode | undefined = doc.nodes[id]?.parentId ? doc.nodes[doc.nodes[id].parentId!] : undefined; n; n = n.parentId ? doc.nodes[n.parentId] : undefined)
    names.unshift(n.name);
  return names.join(" / ");
}
/** Computed layout (Flex/Grid, styles) is what the editor shows. Text is
 * measured with an approximate metric on the server. */
function geometry(doc: SceneDocument) {
  try {
    return computeLayout(doc);
  } catch {
    return doc;
  }
}
function nodeDetail(doc: SceneDocument, layout: SceneDocument, resolved: SceneDocument, id: string): Json {
  const n = doc.nodes[id];
  const { children, assetId, ...rest } = n;
  const r = resolved.nodes[id];
  return {
    ...rest,
    childIds: children,
    page: pageOfNode(doc, id),
    path: pathOf(doc, id),
    worldBox: box(layout, id),
    ...(assetId
      ? { asset: { id: assetId, width: doc.assets[assetId]?.width, height: doc.assets[assetId]?.height, missing: !!doc.assets[assetId]?.missing } }
      : {}),
    // Values after shared styles, tokens and the active theme are applied.
    ...(n.styleRefs
      ? { resolved: { fill: r.fill, fills: r.fills, stroke: r.stroke, radius: r.radius, effects: r.effects, text: r.text, layout: r.layout, width: r.width, height: r.height } }
      : {}),
  };
}
function outline(doc: SceneDocument, layout: SceneDocument, rootId: string, maxDepth: number, maxNodes: number) {
  let count = 0;
  let truncated = false;
  const visit = (id: string, depth: number): Json => {
    count++;
    const n = doc.nodes[id];
    const b = box(layout, id);
    const entry: Json = { id, name: n.name, type: n.type, ...b };
    if (!n.visible) entry.hidden = true;
    if (n.locked) entry.locked = true;
    if (n.text) entry.text = n.text.content.slice(0, 120);
    if (n.component) entry.component = n.component.kind;
    if (n.layout.mode !== "absolute") entry.layout = n.layout.mode;
    if (n.interactions?.length) entry.linksTo = n.interactions.map((i) => i.action.destinationId);
    if (n.children.length) {
      if (depth >= maxDepth || count >= maxNodes) {
        entry.childCount = n.children.length;
        truncated = true;
      } else {
        const kids: Json[] = [];
        for (const c of n.children) {
          if (count >= maxNodes) {
            truncated = true;
            entry.omittedChildren = n.children.length - kids.length;
            break;
          }
          kids.push(visit(c, depth + 1));
        }
        entry.children = kids;
      }
    }
    return entry;
  };
  const tree = visit(rootId, 0);
  return { tree, nodeCount: count, truncated };
}
function intArg(v: unknown, fallback: number, min: number, max: number) {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : fallback;
}
function styleValueSummary(value: unknown) {
  return value && typeof value === "object" && "ref" in (value as Json) ? { token: (value as Json).ref } : value;
}

// ---------- tools ----------

type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  run: (lib: McpLibrary, args: Json, ctx: McpContext) => unknown;
};
const documentIdSchema = { type: "string", description: "Document id from list_documents." };
export const tools: Tool[] = [
  {
    name: "list_documents",
    title: "List documents",
    description: "Documents in this DesignFree library with their pages, screens (top-level frames) and layer counts. Start here to get document and page ids.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (lib) => ({
      libraryVersion: lib.version ?? null,
      updatedAt: lib.updatedAt ?? null,
      documents: allDocuments(lib).map((doc) => ({
        id: doc.id,
        name: doc.name,
        activeInEditor: doc === lib.document,
        layerCount: Object.keys(doc.nodes).length,
        pages: pagesOf(doc).map((pageId) => ({
          id: pageId,
          name: doc.nodes[pageId]?.name,
          screens: screens(doc, pageId).map((s) => ({ id: s.id, name: s.name, width: s.width, height: s.height })),
        })),
      })),
    }),
  },
  {
    name: "get_outline",
    title: "Layer outline",
    description: "Layer tree of a page or of one node: id, name, type, world box (x, y, width, height), text excerpt, layout mode, component role and prototype links. Use maxDepth/maxNodes to stay small, then get_nodes for details.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: documentIdSchema,
        nodeId: { type: "string", description: "Page or layer to start from (default: the document's first page)." },
        maxDepth: { type: "integer", minimum: 1, maximum: 20, default: 4 },
        maxNodes: { type: "integer", minimum: 1, maximum: 2000, default: 300 },
      },
      required: ["documentId"],
      additionalProperties: false,
    },
    run: (lib, args) => {
      const doc = documentById(lib, args.documentId);
      const root = typeof args.nodeId === "string" ? args.nodeId : pagesOf(doc)[0];
      if (!has(doc, root)) fail(`No layer with id ${root} in this document.`);
      return outline(doc, geometry(doc), root, intArg(args.maxDepth, 4, 1, 20), intArg(args.maxNodes, 300, 1, 2000));
    },
  },
  {
    name: "get_nodes",
    title: "Layer details",
    description: "All stored properties of up to 50 layers (transform, size, fills, stroke, text, layout, component and style bindings, prototype links) plus world box, path and, for style-bound layers, the resolved values.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: documentIdSchema,
        nodeIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 },
      },
      required: ["documentId", "nodeIds"],
      additionalProperties: false,
    },
    run: (lib, args) => {
      const doc = documentById(lib, args.documentId);
      const ids = Array.isArray(args.nodeIds) ? args.nodeIds.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
      if (!ids.length) fail("nodeIds must list at least one layer id.");
      const layout = geometry(doc), resolved = resolveDocumentStyles(doc);
      return {
        nodes: ids.map((id) => (has(doc, id) ? nodeDetail(doc, layout, resolved, id) : { id, error: "not found" })),
      };
    },
  },
  {
    name: "search_layers",
    title: "Search layers",
    description: "Find layers whose name or text content contains the query (case-insensitive), across all documents or one. Returns ids, type, path and a text excerpt.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        documentId: documentIdSchema,
        type: { type: "string", enum: ["page", "frame", "group", "rectangle", "ellipse", "path", "text", "image"] },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    run: (lib, args) => {
      const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      if (!query) fail("query is required.");
      const limit = intArg(args.limit, 50, 1, 200);
      const docs = args.documentId === undefined ? allDocuments(lib) : [documentById(lib, args.documentId)];
      const matches: Json[] = [];
      let total = 0;
      for (const doc of docs)
        for (const n of Object.values(doc.nodes)) {
          if (args.type && n.type !== args.type) continue;
          const text = n.text?.content ?? "";
          if (!n.name.toLowerCase().includes(query) && !text.toLowerCase().includes(query)) continue;
          total++;
          if (matches.length < limit)
            matches.push({ documentId: doc.id, document: doc.name, id: n.id, name: n.name, type: n.type, page: pageOfNode(doc, n.id), path: pathOf(doc, n.id), ...(text ? { text: text.slice(0, 200) } : {}) });
        }
      return { total, matches };
    },
  },
  {
    name: "get_text_content",
    title: "Text content",
    description: "All text layers of a page (or one screen) in layer order with their screen, font and content. Useful for copy review and translation.",
    inputSchema: {
      type: "object",
      properties: { documentId: documentIdSchema, nodeId: { type: "string", description: "Page or screen (default: first page)." } },
      required: ["documentId"],
      additionalProperties: false,
    },
    run: (lib, args) => {
      const doc = documentById(lib, args.documentId);
      const root = typeof args.nodeId === "string" ? args.nodeId : pagesOf(doc)[0];
      if (!has(doc, root)) fail(`No layer with id ${root} in this document.`);
      const resolved = resolveDocumentStyles(doc);
      const out: Json[] = [];
      const visit = (id: string, screen: string | null) => {
        const n = doc.nodes[id];
        const here = isScreen(doc, id) ? n.name : screen;
        if (n.text) {
          const t = resolved.nodes[id].text!;
          out.push({ id, name: n.name, screen: here, content: n.text.content, fontFamily: t.fontFamily, fontSize: t.fontSize, fontWeight: t.fontWeight, hidden: !n.visible || undefined });
        }
        n.children.forEach((c) => visit(c, here));
      };
      visit(root, null);
      return { count: out.length, texts: out };
    },
  },
  {
    name: "get_styles",
    title: "Styles, tokens and themes",
    description: "The document's shared colour, text, effect, number, spacing and radius styles, tokens, themes (with the active theme) and pinned shared libraries, plus how many layers use each style.",
    inputSchema: { type: "object", properties: { documentId: documentIdSchema }, required: ["documentId"], additionalProperties: false },
    run: (lib, args) => {
      const doc = documentById(lib, args.documentId);
      const s = doc.styleLibrary;
      const usage: Record<string, number> = {};
      for (const n of Object.values(doc.nodes)) for (const id of Object.values(n.styleRefs ?? {})) if (id) usage[id] = (usage[id] ?? 0) + 1;
      // Layers bind styles; tokens are referenced by styles and themes.
      const tokenRefs: Record<string, number> = {};
      for (const e of Object.values(s?.styles ?? {}))
        if (e.value && typeof e.value === "object" && "ref" in e.value) tokenRefs[(e.value as { ref: string }).ref] = (tokenRefs[(e.value as { ref: string }).ref] ?? 0) + 1;
      const entries = (rec: Record<string, { kind: string; name: string; value: unknown }> = {}, count: Record<string, number>, key: string) =>
        Object.entries(rec).map(([id, e]) => ({ id, kind: e.kind, name: e.name, value: styleValueSummary(e.value), [key]: count[id] ?? 0 }));
      return {
        tokens: entries(s?.tokens, tokenRefs, "referencedByStyles"),
        styles: entries(s?.styles, usage, "usedByLayers"),
        themes: Object.entries(s?.themes ?? {}).map(([id, t]) => ({ id, name: t.name, active: s?.activeTheme === id, values: t.values })),
        sharedLibraries: (doc.sharedStyleLibraries ?? []).map((l) => ({ id: (l as Json).id, name: (l as Json).name })),
      };
    },
  },
  {
    name: "get_components",
    title: "Components and variants",
    description: "Main components (with variant set and properties) and how many instances of each exist, with instance ids.",
    inputSchema: { type: "object", properties: { documentId: documentIdSchema }, required: ["documentId"], additionalProperties: false },
    run: (lib, args) => {
      const doc = documentById(lib, args.documentId);
      const nodes = Object.values(doc.nodes);
      return {
        components: nodes
          .filter((n) => n.component?.kind === "main")
          .map((n) => {
            const c = n.component as Extract<SceneNode["component"], { kind: "main" }>;
            const instances = nodes.filter((i) => i.component?.kind === "instance" && i.component.sourceId === n.id).map((i) => i.id);
            return { id: n.id, name: n.name, page: pageOfNode(doc, n.id), ...(c.variant ? { variantSet: c.variant.setId, properties: c.variant.properties } : {}), instanceCount: instances.length, instanceIds: instances.slice(0, 100) };
          }),
      };
    },
  },
  {
    name: "get_prototype",
    title: "Prototype flow",
    description: "Screens of a page, the start screen and every click link (source layer → destination screen, transition).",
    inputSchema: {
      type: "object",
      properties: { documentId: documentIdSchema, pageId: { type: "string", description: "Default: the document's first page." } },
      required: ["documentId"],
      additionalProperties: false,
    },
    run: (lib, args) => {
      const doc = documentById(lib, args.documentId);
      const pageId = typeof args.pageId === "string" ? args.pageId : pagesOf(doc)[0];
      if (!has(doc, pageId) || doc.nodes[pageId].type !== "page") fail(`No page with id ${pageId}.`);
      const links: Json[] = [];
      for (const n of Object.values(doc.nodes))
        if (pageOfNode(doc, n.id) === pageId)
          for (const i of n.interactions ?? [])
            links.push({ sourceId: n.id, source: n.name, destinationId: i.action.destinationId, destination: doc.nodes[i.action.destinationId]?.name, trigger: i.trigger, transition: i.action.transition });
      return { startScreenId: doc.nodes[pageId].prototypeStartId ?? null, screens: screens(doc, pageId).map((s) => ({ id: s.id, name: s.name })), links };
    },
  },
  {
    name: "export_svg",
    title: "Export SVG",
    description: "SVG markup (returned as plain text) of a page, screen or layer subtree as the editor renders it. Embedded images are replaced by a small placeholder unless includeImages is true. Outputs over 2,000,000 characters are refused rather than cut. Text uses the editor's fonts by name; server-side text metrics are approximate.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: documentIdSchema,
        nodeId: { type: "string", description: "Page, frame or layer to export." },
        includeImages: { type: "boolean", default: false },
      },
      required: ["documentId", "nodeId"],
      additionalProperties: false,
    },
    run: async (lib, args, ctx) => {
      const doc = documentById(lib, args.documentId);
      const id = has(doc, args.nodeId) ? args.nodeId : fail(`No layer with id ${String(args.nodeId)}.`);
      if (!doc.nodes[id].visible) fail("This layer is hidden; nothing would be drawn.");
      // Lay out the whole document first so parent Flex/Grid sizing applies,
      // then render the subtree alone at its own origin.
      const layout = geometry(doc);
      const used = new Set<string>();
      const visit = (n: string) => {
        const node = layout.nodes[n];
        if (node.assetId) used.add(node.assetId);
        node.children.forEach(visit);
      };
      visit(id);
      const assets: SceneDocument["assets"] = {};
      for (const assetId of used) {
        const a = layout.assets[assetId];
        if (!a) continue;
        let dataUrl = MISSING_PNG;
        if (args.includeImages === true) {
          const blobKey = (a as { blobKey?: string }).blobKey;
          if (/^data:image\/png;base64,/.test(a.dataUrl ?? "")) dataUrl = a.dataUrl;
          else if (blobKey && ctx.readImage)
            dataUrl = await ctx
              .readImage(doc.id, blobKey)
              .then((bytes) => `data:image/png;base64,${bytes.toString("base64")}`)
              .catch(() => MISSING_PNG);
        }
        assets[assetId] = { ...a, dataUrl };
      }
      const sub: SceneDocument = { ...layout, rootId: id, pageIds: undefined, assets, nodes: { ...layout.nodes, [id]: { ...layout.nodes[id], transform: [1, 0, 0, 1, 0, 0] } } };
      const svg = exportSvg(sub);
      if (svg.length > MAX_SVG)
        fail(`The SVG is ${svg.length.toLocaleString("en")} characters (limit ${MAX_SVG.toLocaleString("en")}). Export a smaller layer${args.includeImages === true ? " or leave includeImages off" : ""}.`);
      return new RawText(svg);
    },
  },
];

// ---------- JSON-RPC ----------

const result = (id: unknown, value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const error = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
function text(value: unknown) {
  let body = JSON.stringify(value, null, 1);
  if (body.length > MAX_TEXT) body = body.slice(0, MAX_TEXT) + `\n… truncated at ${MAX_TEXT} characters; narrow the request (maxNodes, nodeId, limit).`;
  return body;
}

/** One JSON-RPC message. Returns undefined for notifications (no reply). */
export async function handleRpc(message: Rpc, ctx: McpContext): Promise<Json | undefined> {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string")
    return error((message as Rpc)?.id, -32600, "Invalid Request");
  const { id, method } = message;
  const params = (message.params && typeof message.params === "object" ? message.params : {}) as Json;
  if (id === undefined || id === null) return undefined; // notifications: initialized, cancelled …
  switch (method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return result(id, {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "designfree", title: "DesignFree", version: "0.1.0" },
        instructions:
          "Read-only access to a DesignFree design library. Call list_documents first, then get_outline for structure, get_nodes for details, search_layers to find layers, and export_svg to see a screen. Ids are stable; nothing here changes the design.",
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, {
        tools: tools.map(({ name, title, description, inputSchema }) => ({
          name,
          title,
          description,
          inputSchema,
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        })),
      });
    case "tools/call": {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return error(id, -32602, `Unknown tool: ${String(params.name)}`);
      const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Json;
      try {
        const library = await ctx.load();
        if (!library) return result(id, { content: [{ type: "text", text: "The library is empty: no document has been saved on this server yet." }], isError: true });
        const value = await tool.run(library, args, ctx);
        return result(id, { content: [{ type: "text", text: value instanceof RawText ? value.text : text(value) }] });
      } catch (e) {
        if (e instanceof ToolError) return result(id, { content: [{ type: "text", text: e.message }], isError: true });
        // Unexpected failures stay inside the JSON-RPC reply.
        console.error("MCP tool failed", tool.name, e instanceof Error ? e.name : "UnknownError");
        return result(id, { content: [{ type: "text", text: `${tool.name} failed on this document (${e instanceof Error ? e.message : "unknown error"}).` }], isError: true });
      }
    }
    case "resources/list":
      return result(id, { resources: [] });
    case "prompts/list":
      return result(id, { prompts: [] });
    default:
      return error(id, -32601, `Method not found: ${method}`);
  }
}
