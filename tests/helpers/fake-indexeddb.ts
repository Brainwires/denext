// A minimal in-memory IndexedDB for unit tests (Deno has none): `open` with
// `onupgradeneeded`, out-of-line keys (arrays included, in IndexedDB's key order), `get` /
// `put` / `delete` (a key or a range) / `getAllKeys(range)`, transactions that complete once
// their requests have run, and `IDBKeyRange.bound`. Only what src/mobile/kv-store.ts uses.

// deno-lint-ignore no-explicit-any
type Any = any;

/** IndexedDB's key order: numbers < strings < arrays (element by element). */
function compareKeys(a: unknown, b: unknown): number {
  const rank = (k: unknown) => (typeof k === "number" ? 0 : typeof k === "string" ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compareKeys(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
}

/** A closed key range. */
class FakeRange {
  constructor(readonly lower: unknown, readonly upper: unknown) {}
  static bound(lower: unknown, upper: unknown): FakeRange {
    return new FakeRange(lower, upper);
  }
  includes(key: unknown): boolean {
    return compareKeys(key, this.lower) >= 0 && compareKeys(key, this.upper) <= 0;
  }
}

/** A request that settles on a later tick. */
function request<T>(tx: { pending: number; settle(): void }, work: () => T): Any {
  const req: Any = { result: undefined, error: null, onsuccess: null, onerror: null };
  tx.pending++;
  setTimeout(() => {
    try {
      req.result = work();
      req.onsuccess?.();
    } catch (e) {
      req.error = e;
      req.onerror?.();
    }
    tx.pending--;
    tx.settle();
  }, 0);
  return req;
}

/** One database: object stores as sorted key/value lists. */
function database(stores: Map<string, Map<string, { key: unknown; value: unknown }>>) {
  const id = (key: unknown) => JSON.stringify(key);
  return {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore(name: string) {
      stores.set(name, new Map());
    },
    transaction(name: string, _mode: string) {
      const tx: Any = {
        pending: 0,
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
        settle() {
          if (tx.pending === 0) setTimeout(() => tx.pending === 0 && tx.oncomplete?.(), 0);
        },
        objectStore() {
          const data = stores.get(name)!;
          return {
            get: (key: unknown) => request(tx, () => data.get(id(key))?.value),
            put: (value: unknown, key: unknown) =>
              request(tx, () => void data.set(id(key), { key, value })),
            delete: (key: unknown) =>
              request(tx, () => {
                for (const [k, e] of [...data]) {
                  if (key instanceof FakeRange ? key.includes(e.key) : k === id(key)) {
                    data.delete(k);
                  }
                }
              }),
            getAllKeys: (range: FakeRange) =>
              request(
                tx,
                () =>
                  [...data.values()].map((e) => e.key).filter((k) => range.includes(k)).sort(
                    compareKeys,
                  ),
              ),
          };
        },
      };
      // A transaction with no request still completes.
      tx.settle();
      return tx;
    },
  };
}

/** A fresh factory (`indexedDB`) and its `IDBKeyRange`. */
export function fakeIndexedDB(): { indexedDB: Any; IDBKeyRange: Any } {
  const dbs = new Map<string, Map<string, Map<string, { key: unknown; value: unknown }>>>();
  return {
    indexedDB: {
      open(name: string) {
        const req: Any = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null };
        setTimeout(() => {
          const fresh = !dbs.has(name);
          if (fresh) dbs.set(name, new Map());
          req.result = database(dbs.get(name)!);
          if (fresh) req.onupgradeneeded?.();
          req.onsuccess?.();
        }, 0);
        return req;
      },
    },
    IDBKeyRange: FakeRange,
  };
}
