import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

// Install the portable default with: npx playwright install chromium
// An explicit executable takes precedence over an optional installed channel.
export function browserLaunchOptions() {
  return {
    headless: true,
    ...(process.env.CHROME_EXECUTABLE
      ? { executablePath: process.env.CHROME_EXECUTABLE }
      : process.env.PLAYWRIGHT_CHANNEL
        ? { channel: process.env.PLAYWRIGHT_CHANNEL }
        : {}),
  };
}

// Generated evidence stays inside the clone and outside fingerprinted sources.
export function artifactPath(name = "") {
  const output = path.resolve(repositoryRoot, "test-results", name);
  mkdirSync(name ? path.dirname(output) : output, { recursive: true });
  return output;
}

// Server fixtures modify owner/library data: the caller must choose a test URL.
export function serverTestUrl() {
  assert.ok(
    process.env.DRAFTROOM_URL,
    "Set DRAFTROOM_URL explicitly to a disposable test instance",
  );
  return new URL(process.env.DRAFTROOM_URL).href;
}
