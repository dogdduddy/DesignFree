import { browserLaunchOptions } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";

// Real browser IndexedDB, isolated from the editor's automatic saving effect.
const browser = await chromium.launch(browserLaunchOptions());
try {
  const page = await browser.newPage();
  const base = process.env.EDITOR_URL || "http://127.0.0.1:5173/";
  const isolatedUrl = new URL("storage-test.html", base).href;
  await page.route(isolatedUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Draft storage test</title>",
    }),
  );
  await page.goto(isolatedUrl);
  const checks = await page.evaluate(async () => {
    const storage = await import("/src/local-draft-storage.ts");
    const { createDemoDocument } = await import("/src/core/fixtures.ts");
    const {
      DRAFT_DB_NAME,
      DRAFT_STORE_NAME,
      DRAFT_KEY,
      loadLocalDraft,
      saveLocalDraft,
      DraftConflictError,
    } = storage;
    const checks = [];
    const check = (condition, message) => {
      if (!condition) throw new Error(message);
      checks.push(message);
    };
    const rejects = async (operation, predicate = () => true) => {
      try {
        await operation();
      } catch (error) {
        if (!predicate(error)) throw error;
        return error;
      }
      throw new Error("Expected operation to reject");
    };
    const raw = async (write, value) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DRAFT_DB_NAME, 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(
            DRAFT_STORE_NAME,
            write ? "readwrite" : "readonly",
          );
          const store = tx.objectStore(DRAFT_STORE_NAME);
          const request = write ? store.put(value, DRAFT_KEY) : store.getAll();
          let result;
          request.onsuccess = () => {
            result = request.result;
          };
          tx.oncomplete = () => resolve(result);
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    };
    check((await loadLocalDraft()) === null, "Absent draft loads as null");
    check(
      (await raw(false)).length === 0,
      "Loading absence never writes a default draft",
    );
    const document = createDemoDocument();
    const expectedName = document.name;
    const pending = saveLocalDraft(document, null);
    document.name = "mutated during save";
    const first = await pending;
    check(
      first.revision === 1 && first.document.name === expectedName,
      "First save snapshots input before yielding",
    );
    check(
      first.updatedAt === new Date(first.updatedAt).toISOString(),
      "Save has an ISO timestamp",
    );
    first.document.name = "mutated return";
    const loaded = await loadLocalDraft();
    check(
      loaded.document.name === expectedName,
      "Returned records cannot mutate stored data",
    );
    check(
      JSON.stringify(loaded.document.assets) ===
        JSON.stringify(document.assets),
      "Owned PNG assets round trip intact",
    );
    loaded.document.name = "mutated load";
    check(
      (await loadLocalDraft()).document.name === expectedName,
      "Loaded snapshots are isolated",
    );
    const second = await saveLocalDraft(document, 1);
    check(second.revision === 2, "Sequential saves increment revision");
    await rejects(
      () => saveLocalDraft(document, 1),
      (e) => e instanceof DraftConflictError,
    );
    await rejects(
      () => saveLocalDraft(document, null),
      (e) => e instanceof DraftConflictError,
    );
    check(
      (await loadLocalDraft()).revision === 2,
      "Stale and first-save conflicts preserve the record",
    );
    const concurrent = await Promise.allSettled([
      saveLocalDraft({ ...document, name: "writer a" }, 2),
      saveLocalDraft({ ...document, name: "writer b" }, 2),
    ]);
    check(
      concurrent.filter((r) => r.status === "fulfilled").length === 1 &&
        concurrent.filter(
          (r) =>
            r.status === "rejected" && r.reason instanceof DraftConflictError,
        ).length === 1,
      "Concurrent compare-and-swap has exactly one winner",
    );
    const preserved = await loadLocalDraft();
    check(
      preserved.revision === 3,
      "Concurrent save advances revision only once",
    );

    const originalPut = IDBObjectStore.prototype.put;
    let requestSucceeded = false;
    IDBObjectStore.prototype.put = function (...args) {
      const request = originalPut.apply(this, args);
      if (this.name === DRAFT_STORE_NAME) {
        const tx = this.transaction;
        request.addEventListener("success", () => {
          requestSucceeded = true;
          tx.abort();
        });
      }
      return request;
    };
    try {
      await rejects(() => saveLocalDraft(document, 3));
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    check(
      requestSucceeded &&
        JSON.stringify(await loadLocalDraft()) === JSON.stringify(preserved),
      "Abort after write-request success rejects and retains the previous committed draft",
    );

    await rejects(() => saveLocalDraft({ ...document, schemaVersion: 99 }, 3));
    check(
      JSON.stringify(await loadLocalDraft()) === JSON.stringify(preserved),
      "Invalid incoming document never writes",
    );
    const invalidRecords = [
      { ...preserved, version: 99 },
      { ...preserved, revision: 0 },
      { ...preserved, revision: 1.5 },
      { ...preserved, updatedAt: "not a date" },
      { ...preserved, document: { ...document, schemaVersion: 99 } },
      { ...preserved, document: { ...document, rootId: "missing" } },
      undefined,
    ];
    for (const invalid of invalidRecords) {
      await raw(true, invalid);
      await rejects(() => loadLocalDraft());
      await rejects(() => saveLocalDraft(document, invalid?.revision ?? null));
      const records = await raw(false);
      check(
        records.length === 1 &&
          JSON.stringify(records[0]) === JSON.stringify(invalid),
        `Corrupt record preserved: ${invalid === undefined ? "undefined" : JSON.stringify([invalid.version, invalid.revision, invalid.updatedAt, invalid.document.rootId, invalid.document.schemaVersion])}`,
      );
    }
    await raw(true, preserved);
    const idbDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "indexedDB",
    );
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      get() {
        throw new DOMException("Storage disabled", "SecurityError");
      },
    });
    try {
      await rejects(
        () => loadLocalDraft(),
        (e) => e.name === "SecurityError",
      );
      await rejects(
        () => saveLocalDraft(document, 3),
        (e) => e.name === "SecurityError",
      );
    } finally {
      if (idbDescriptor)
        Object.defineProperty(globalThis, "indexedDB", idbDescriptor);
      else delete globalThis.indexedDB;
    }
    check(
      JSON.stringify(await loadLocalDraft()) === JSON.stringify(preserved),
      "Unavailable IndexedDB rejects without replacing saved content",
    );

    // Delay delivery of a genuine successful native open past the bounded timeout.
    const nativeOpen = IDBFactory.prototype.open;
    let lateClosed = false;
    IDBFactory.prototype.open = function (...args) {
      const request = nativeOpen.apply(this, args);
      const delayed = {};
      request.onsuccess = () => {
        const db = request.result;
        const close = db.close.bind(db);
        db.close = () => {
          lateClosed = true;
          close();
        };
        delayed.result = db;
        setTimeout(() => delayed.onsuccess?.(), 3250);
      };
      request.onerror = () => {
        delayed.error = request.error;
        delayed.onerror?.();
      };
      return delayed;
    };
    const started = performance.now();
    try {
      await rejects(
        () => loadLocalDraft(),
        (e) => /timed out/.test(e.message),
      );
      check(performance.now() - started < 3200, "Open timeout is bounded");
      await new Promise((resolve) => setTimeout(resolve, 400));
      check(
        lateClosed,
        "Successful connection arriving after timeout is closed",
      );
    } finally {
      IDBFactory.prototype.open = nativeOpen;
    }
    check(
      JSON.stringify(await loadLocalDraft()) === JSON.stringify(preserved),
      "Late open does not alter the saved draft",
    );
    return checks;
  });
  assert(checks.length >= 20);
  console.log(JSON.stringify({ status: "passed", checks }, null, 2));
} finally {
  await browser.close();
}
