// DesignFree bridge for Claude Desktop (packed as server/index.js in the
// .mcpb bundle). Claude Desktop speaks MCP over stdio; this forwards each
// newline-delimited JSON-RPC message to the team server's /api/mcp with the
// personal token and writes the reply back. No dependencies: Claude Desktop
// runs it with its bundled Node.js.
"use strict";

const url = process.env.DESIGNFREE_URL;
const token = process.env.DESIGNFREE_TOKEN;
let protocolVersion;
let queue = Promise.resolve();
let buffer = "";

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
// Only requests (with an id) get an answer; notifications are dropped.
const fail = (message, text) => {
  for (const m of [].concat(message))
    if (m && m.id !== undefined && m.id !== null) write({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: text } });
};

async function forward(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  let text, status, type;
  try {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    };
    if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;
    const response = await fetch(url, { method: "POST", headers, body: line, signal: AbortSignal.timeout(60_000) });
    text = await response.text();
    status = response.status;
    type = response.headers.get("content-type") ?? "";
  } catch (error) {
    return fail(message, `DesignFree 서버(${url})에 연결할 수 없습니다. 같은 Wi-Fi에 있는지 확인하세요. (${error.message})`);
  }
  if (status === 401)
    return fail(message, "DesignFree 토큰이 폐기되었거나 올바르지 않습니다. 편집기의 AI 연결에서 새 설치 파일을 받으세요.");
  if (status < 200 || status >= 300) return fail(message, `DesignFree 서버 오류 (HTTP ${status})`);
  let replies;
  try {
    // The server answers JSON; an SSE body is accepted too: one message per
    // event (its data lines joined), skipping events without data.
    replies = type.includes("text/event-stream")
      ? text
          .split(/\r?\n\r?\n/)
          .map((event) =>
            event
              .split(/\r?\n/)
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).replace(/^ /, ""))
              .join("\n"),
          )
          .filter((data) => data.trim())
          .map((data) => JSON.parse(data))
      : text.trim() ? [JSON.parse(text)] : [];
  } catch {
    return fail(message, `DesignFree 서버(${url})가 예상하지 못한 응답을 보냈습니다. 주소가 맞는지 확인하세요.`);
  }
  for (const reply of replies) {
    if (message.method === "initialize" && typeof reply?.result?.protocolVersion === "string")
      protocolVersion = reply.result.protocolVersion;
    write(reply);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    // One at a time, so replies keep the order of the requests.
    if (line) queue = queue.then(() => forward(line));
  }
});
// Exit once every reply has been flushed (pipe writes are asynchronous on macOS).
process.stdin.on("end", () => queue.then(() => process.stdout.write("", () => process.exit(0))));
