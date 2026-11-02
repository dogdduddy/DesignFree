import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "../src/random-id";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
describe("randomId", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("uses crypto.randomUUID when the context provides it", () => {
    expect(randomId()).toMatch(UUID_V4);
  });
  it("falls back to getRandomValues where randomUUID is missing (plain-http LAN)", () => {
    // Insecure contexts expose getRandomValues but not randomUUID.
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    expect("randomUUID" in globalThis.crypto).toBe(false);
    const ids = new Set(Array.from({ length: 1000 }, randomId));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });
});
