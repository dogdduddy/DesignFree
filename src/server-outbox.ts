/** One origin-local journal, separate from the browser-only document library.
 * Compare-and-swap prevents a second tab from replacing an unresolved writer.
 * Resolve only after transaction completion; an unavailable disk stops PUTs.
 */
export class ServerOutbox {
  async transact(
    expected?: string | null,
    next?: string | null,
  ): Promise<string | null> {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error("Opening server outbox timed out"));
      }, 3000);
      const request = indexedDB.open("draftroom-server-outbox", 1);
      const fail = () => {
        clearTimeout(timer);
        settled = true;
        reject(request.error ?? new Error("Server outbox unavailable"));
      };
      request.onblocked = fail;
      request.onerror = fail;
      request.onupgradeneeded = () => {
        if (settled) request.transaction?.abort();
        else request.result.createObjectStore("requests");
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        if (settled) request.result.close();
        else resolve(request.result);
      };
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(
          "requests",
          expected === undefined ? "readonly" : "readwrite",
        );
        const store = transaction.objectStore("requests");
        let value: string | null = null;
        let failure: Error | undefined;
        transaction.oncomplete = () => resolve(value);
        transaction.onabort = () =>
          reject(
            failure ??
              transaction.error ??
              new Error("Server outbox transaction aborted"),
          );
        transaction.onerror = () => {
          failure ??=
            transaction.error ?? new Error("Server outbox write failed");
        };
        database.onversionchange = () => {
          transaction.abort();
          database.close();
        };
        const count = store.count("current");
        const read = store.get("current");
        read.onsuccess = () => {
          value = count.result === 0 ? null : read.result;
          if (value !== null && typeof value !== "string") {
            failure = new Error("Invalid server outbox record");
            transaction.abort();
          } else if (expected !== undefined) {
            if (value !== expected) {
              failure = new Error(
                "Another tab owns the unresolved server outbox. Recover it in a new tab before saving this work.",
              );
              transaction.abort();
            } else if (next === null) store.delete("current");
            else store.put(next, "current");
          }
        };
      });
    } finally {
      database.close();
    }
  }
}
