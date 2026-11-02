import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 as zlibCrc32 } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundleFileName,
  claudeCodeCommand,
  claudeDesktopBundle,
  codexCommand,
  colleagueMessage,
} from "../src/mcp-connect";
import { crc32, zipStore } from "../src/zip";

const endpoint = "http://10.0.0.5:4173/api/mcp";
const token = "dft_" + "A1b2_C3d-".repeat(5);
const bridge = join(__dirname, "../src/claude-desktop-bridge.cjs");

/** Reads a stored ZIP through its central directory. */
function unzip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const data = bytes.subarray(start, start + size);
    expect(zlibCrc32(data)).toBe(crc);
    files[name] = new TextDecoder().decode(data);
    at += 46 + nameLength;
  }
  return files;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "designfree-connect-"));
  dirs.push(dir);
  return dir;
};

describe("zip writer", () => {
  it("matches zlib's CRC-32 and round-trips UTF-8 names and contents", () => {
    const sample = new TextEncoder().encode("디자인 DesignFree");
    expect(crc32(sample)).toBe(zlibCrc32(sample));
    const files = unzip(zipStore([{ name: "a.txt", data: "hello" }, { name: "폴더/b.json", data: "{\"k\":1}" }]));
    expect(files).toEqual({ "a.txt": "hello", "폴더/b.json": "{\"k\":1}" });
  });

  it("is readable by the system unzip", () => {
    const dir = tempDir();
    const file = join(dir, "x.zip");
    writeFileSync(file, zipStore([{ name: "manifest.json", data: "{}" }, { name: "server/index.js", data: "1" }]));
    expect(execFileSync("unzip", ["-t", file], { encoding: "utf8" })).toContain("No errors detected");
  });
});

describe("Claude Desktop bundle", () => {
  it("packs a manifest at the root that runs the bridge with endpoint and token", () => {
    const files = unzip(claudeDesktopBundle(endpoint, token, new Date("2026-11-02T00:00:00Z")));
    expect(Object.keys(files)).toEqual(["manifest.json", "server/index.js"]);
    const manifest = JSON.parse(files["manifest.json"]);
    expect(manifest).toMatchObject({
      manifest_version: "0.3",
      name: "designfree",
      version: "1.0.1793577600",
      author: { name: "DesignFree" },
      server: {
        type: "node",
        entry_point: "server/index.js",
        mcp_config: { command: "node", args: ["${__dirname}/server/index.js"], env: { DESIGNFREE_URL: endpoint, DESIGNFREE_TOKEN: token } },
      },
    });
    expect(files["server/index.js"]).toBe(readFileSync(bridge, "utf8"));
  });

  it("names the file after the token", () => {
    expect(bundleFileName("홍길동 Claude Desktop")).toBe("designfree-홍길동-Claude-Desktop.mcpb");
    expect(bundleFileName("  ")).toBe("designfree.mcpb");
    expect(bundleFileName("a/b\\c")).toBe("designfree-a-b-c.mcpb");
  });
});

describe("pasteable commands", () => {
  it("registers Claude Code for every folder and replaces an earlier registration", () => {
    expect(claudeCodeCommand(endpoint, token)).toBe(
      `claude mcp remove designfree -s local >/dev/null 2>&1; claude mcp remove designfree -s user >/dev/null 2>&1; claude mcp add --scope user --transport http designfree ${endpoint} --header "Authorization: Bearer ${token}"`,
    );
  });

  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    it(`writes Codex config.toml idempotently (${shell})`, () => {
      const home = tempDir();
      const config = join(home, "config.toml");
      writeFileSync(
        config,
        [
          'model = "gpt-5"',
          "",
          "[mcp_servers.other]",
          'command = "x"',
          "",
          "[mcp_servers.designfree]",
          'url = "http://old/api/mcp"',
          'bearer_token_env_var = "DESIGNFREE_TOKEN"',
          "",
          "[mcp_servers.designfree.tools.export_svg]",
          'approval_mode = "approve"',
          "",
          "[mcp_servers.designfree_two]",
          'url = "keep"',
          "",
          '[ mcp_servers."designfree" ]',
          'url = "http://old-quoted/api/mcp"',
          "",
        ].join("\n"),
      );
      const original = readFileSync(config, "utf8");
      const run = () =>
        execFileSync(shell, ["-c", codexCommand(endpoint, token)], { env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home }, encoding: "utf8" });
      expect(run()).toContain("Codex에 DesignFree를 연결했습니다.");
      run();
      const result = readFileSync(config, "utf8");
      expect(result.match(/\[mcp_servers\.designfree\]/g)).toHaveLength(1);
      expect(result).not.toContain("http://old");
      expect(result).not.toContain("tools.export_svg");
      expect(result).toContain('[mcp_servers.other]\ncommand = "x"');
      expect(result).toContain('[mcp_servers.designfree_two]\nurl = "keep"');
      expect(result).not.toContain("old-quoted");
      // No blank lines pile up across runs.
      expect(result.endsWith(`url = "keep"\n\n[mcp_servers.designfree]\nurl = "${endpoint}"\nhttp_headers = { "Authorization" = "Bearer ${token}" }\n`)).toBe(true);
      // The backup keeps the original from before the first run.
      expect(readFileSync(`${config}.bak`, "utf8")).toBe(original);
      expect(existsSync(`${config}.tmp`)).toBe(false);
    });
  }

  it("creates Codex config.toml when there is none", () => {
    const home = tempDir();
    execFileSync("/bin/zsh", ["-c", codexCommand(endpoint, token)], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
    expect(readFileSync(join(home, ".codex/config.toml"), "utf8")).toBe(
      `\n[mcp_servers.designfree]\nurl = "${endpoint}"\nhttp_headers = { "Authorization" = "Bearer ${token}" }\n`,
    );
    // A new file holding the token is private to the user, and so is an existing one.
    expect(statSync(join(home, ".codex/config.toml")).mode & 0o777).toBe(0o600);
    chmodSync(join(home, ".codex/config.toml"), 0o644);
    execFileSync("/bin/zsh", ["-c", codexCommand(endpoint, token)], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
    expect(statSync(join(home, ".codex/config.toml")).mode & 0o777).toBe(0o600);
  });

  it("builds a colleague message with all three ways and the bundle name", () => {
    const message = colleagueMessage(endpoint, token, "홍길동");
    expect(message).toContain(claudeCodeCommand(endpoint, token));
    expect(message).toContain(codexCommand(endpoint, token));
    expect(message).toContain("designfree-홍길동.mcpb");
  });
});

describe("Claude Desktop stdio bridge", () => {
  async function withServer(handler: (body: any, request: IncomingMessage) => { status: number; body?: unknown; raw?: string; type?: string }) {
    const seen: { body: any; headers: IncomingMessage["headers"] }[] = [];
    const server = createServer(async (request, response) => {
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      seen.push({ body, headers: request.headers });
      const reply = handler(body, request);
      response.writeHead(reply.status, { "Content-Type": reply.type ?? "application/json" });
      response.end(reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body)));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}/api/mcp`, seen, close: () => new Promise((r) => server.close(r)) };
  }

  function runBridge(url: string, auth: string, lines: unknown[]) {
    return new Promise<any[]>((resolve, reject) => {
      const child = spawn(process.execPath, [bridge], { env: { DESIGNFREE_URL: url, DESIGNFREE_TOKEN: auth } });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("error", reject);
      child.on("close", () => resolve(out.split("\n").filter(Boolean).map((l) => JSON.parse(l))));
      // Split a message across writes to exercise line buffering.
      const text = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";
      child.stdin.write(text.slice(0, 7));
      child.stdin.end(text.slice(7));
    });
  }

  it("forwards requests in order with the token and negotiated protocol version", async () => {
    const server = await withServer((body, request) => {
      if (request.headers.authorization !== `Bearer ${token}`) return { status: 401, body: { error: "token_required" } };
      if (body.id === undefined) return { status: 202 };
      if (body.method === "initialize") return { status: 200, body: { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } } };
      return { status: 200, body: { jsonrpc: "2.0", id: body.id, result: { echo: body.method } } };
    });
    const replies = await runBridge(server.url, token, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      "not json",
      { jsonrpc: "2.0", id: "x", method: "tools/call" },
    ]);
    await server.close();
    expect(replies).toEqual([
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, result: { echo: "tools/list" } },
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { jsonrpc: "2.0", id: "x", result: { echo: "tools/call" } },
    ]);
    expect(server.seen[0].headers["mcp-protocol-version"]).toBeUndefined();
    expect(server.seen[2].headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(server.seen[2].headers.origin).toBeUndefined();
  });

  it("answers requests with a clear error when the token is revoked or the server is unreachable", async () => {
    const server = await withServer(() => ({ status: 401, body: { error: "token_required" } }));
    const revoked = await runBridge(server.url, "dft_wrong", [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
    ]);
    await server.close();
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ id: 3, error: { code: -32000 } });
    expect(revoked[0].error.message).toContain("토큰");

    const offline = await runBridge(server.url, token, [{ jsonrpc: "2.0", id: 4, method: "ping" }]);
    expect(offline[0]).toMatchObject({ id: 4, error: { code: -32000 } });
    expect(offline[0].error.message).toContain("연결할 수 없습니다");
  });

  it("reports unexpected bodies, accepts SSE and flushes large replies before exiting", async () => {
    const big = "x".repeat(2_000_000);
    const server = await withServer((body) => {
      if (body.id === 1) return { status: 200, raw: "<html>proxy</html>", type: "text/html" };
      // A priming event without data, then one message split over two data lines.
      if (body.id === 2) return { status: 200, raw: `id: 0\ndata:\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,\ndata: "result":{"sse":true}}\n\n`, type: "text/event-stream" };
      return { status: 200, body: { jsonrpc: "2.0", id: body.id, result: { big } } };
    });
    const replies = await runBridge(server.url, token, [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { jsonrpc: "2.0", id: 3, method: "ping" },
      { jsonrpc: "2.0", id: 4, method: "ping" },
    ]);
    await server.close();
    expect(replies[0].error.message).toContain("예상하지 못한 응답");
    expect(replies[1]).toEqual({ jsonrpc: "2.0", id: 2, result: { sse: true } });
    expect(replies.slice(2).map((r) => r.result.big.length)).toEqual([2_000_000, 2_000_000]);
  });
});
