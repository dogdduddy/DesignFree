import { serverTestUrl } from "./browser-helpers.mjs";
import assert from "node:assert/strict";
import { request } from "@playwright/test";

// There is no test bypass: use credentials belonging to the disposable instance.
export async function authenticatedTestSession(url) {
  assert.equal(
    new URL(url).origin,
    new URL(serverTestUrl()).origin,
    "Authenticated fixtures must use the explicit disposable DRAFTROOM_URL",
  );
  const username = process.env.DRAFTROOM_TEST_USERNAME;
  const password = process.env.DRAFTROOM_TEST_PASSWORD;
  assert.ok(
    username && password,
    "Set DRAFTROOM_TEST_USERNAME and DRAFTROOM_TEST_PASSWORD to the test instance owner credentials",
  );
  const api = await request.newContext({ baseURL: url });
  try {
    const statusResponse = await api.get("/api/auth/status");
    assert.equal(statusResponse.status(), 200);
    const status = await statusResponse.json();
    if (!status.initialized) {
      const setup = await api.post("/api/auth/setup", {
        data: { username, password },
      });
      assert.ok(
        [200, 201, 409].includes(setup.status()),
        `Owner setup failed: ${setup.status()}`,
      );
    }
    const login = await api.post("/api/auth/login", {
      data: { username, password },
    });
    assert.equal(login.status(), 200, `Owner login failed: ${login.status()}`);
    const storageState = await api.storageState();
    const cookie = storageState.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    assert.ok(cookie, "Owner login did not create a session cookie");
    return {
      storageState,
      fetch: (path, options = {}) => {
        const headers = new Headers(options.headers);
        headers.set("Cookie", cookie);
        return fetch(new URL(path, url), { ...options, headers });
      },
    };
  } finally {
    await api.dispose();
  }
}
