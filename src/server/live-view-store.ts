/**
 * The shared live-view store: where a parked view's model waits so a reconnect that lands on
 * another instance resumes it (`defineLiveView`). Install one at startup:
 *
 * ```ts
 * // instrumentation.ts (or any module the server loads at startup)
 * import { redisLiveViewStore, setLiveViewStore } from "denext/server";
 * setLiveViewStore(redisLiveViewStore({ url: Deno.env.get("REDIS_URL") }));
 * ```
 *
 * When a socket drops, the hub parks each of its views in the process (as before) and also
 * writes a snapshot — the view id, the signed props it was mounted with, the viewer it was
 * mounted for, and its model — to the store for `live.limits.viewResumeSeconds`. Only the same
 * viewer resumes it (another account or a signed-out viewer runs `init`). A reconnect naming the instance id takes the
 * snapshot back (once: `take` reads and deletes it), so any instance can resume the model.
 *
 * A snapshot is sealed with AES-256-GCM under a key derived from the view secret
 * (`DENEXT_LIVE_VIEW_SECRET`, the key the page's props tokens are signed with) and bound to its
 * instance id, so the store holds no readable model and a snapshot moved to another id does not
 * open. Every instance must share that secret: without it each process has a random one and
 * cannot open the others' snapshots (the view runs `init` again, the documented fallback).
 *
 * Models must be serializable to be stored: plain data plus what the wire codec carries (`Date`,
 * `Map`, `Set`, `BigInt`, `URL`, …). A model holding a function or a class instance is parked
 * in the process only. The default store is in memory (per process); it bounds itself to
 * {@linkcode MemoryLiveViewStoreOptions.maxEntries} snapshots.
 *
 * @module
 */

import { liveViewSecret } from "../runtime/live-view.ts";
import { decodeWire } from "../runtime/wire-codec.ts";
import { prepareWire } from "../runtime/wire-encode.ts";
import { fromBase64Url, toBase64Url } from "./session.ts";

/**
 * Where parked live views wait between instances. Values are opaque sealed strings; a store
 * only has to keep them for `ttlSeconds` and hand each back once.
 */
export interface LiveViewStore {
  /**
   * Store (or replace) the snapshot of instance `id`.
   *
   * @param id The view instance id.
   * @param sealed The sealed snapshot.
   * @param ttlSeconds How long it may be resumed.
   */
  set(id: string, sealed: string, ttlSeconds: number): Promise<void>;
  /**
   * Read and delete the snapshot of instance `id` atomically, so two instances never both
   * resume it.
   *
   * @param id The view instance id.
   * @returns The sealed snapshot, or `null` when there is none (or it expired).
   */
  take(id: string): Promise<string | null>;
  /**
   * Drop the snapshot of instance `id` (it resumed in the process that parked it).
   *
   * @param id The view instance id.
   */
  delete(id: string): Promise<void>;
}

/** Options for {@linkcode memoryLiveViewStore}. */
export interface MemoryLiveViewStoreOptions {
  /** Snapshots kept at once; parking another drops the oldest (default 1000). */
  maxEntries?: number;
}

/**
 * The in-memory {@linkcode LiveViewStore} (the default): one process, bounded, expiring.
 *
 * @param options The entry cap.
 * @returns The store.
 */
export function memoryLiveViewStore(options: MemoryLiveViewStoreOptions = {}): LiveViewStore {
  const max = options.maxEntries ?? 1000;
  const entries = new Map<string, { sealed: string; expires: number }>();
  return {
    set(id, sealed, ttlSeconds) {
      entries.delete(id);
      entries.set(id, { sealed, expires: Date.now() + ttlSeconds * 1000 });
      while (entries.size > max) entries.delete(entries.keys().next().value as string);
      return Promise.resolve();
    },
    take(id) {
      const entry = entries.get(id);
      entries.delete(id);
      return Promise.resolve(entry && entry.expires > Date.now() ? entry.sealed : null);
    },
    delete(id) {
      entries.delete(id);
      return Promise.resolve();
    },
  };
}

let installed: LiveViewStore | null = null;

/**
 * Install the store parked live views are written to (the default is
 * {@linkcode memoryLiveViewStore}, per process). Call it once at startup, before the first
 * socket connects; every instance of the app must share the store and `DENEXT_LIVE_VIEW_SECRET`.
 *
 * @param store The store, or `null` to go back to the in-memory default.
 */
export function setLiveViewStore(store: LiveViewStore | null): void {
  installed = store;
}

/**
 * The installed store (the in-memory default until {@linkcode setLiveViewStore} runs).
 *
 * @returns The store.
 */
export function getLiveViewStore(): LiveViewStore {
  return installed ??= memoryLiveViewStore();
}

/** What a snapshot carries. The props come from the remount (verified against `signed`). */
export interface ViewSnapshot {
  /** The view id. */
  view: string;
  /**
   * `resumeKey`: the view and a digest of its signed props; a resume presents the same props
   * under a token that verifies now (not necessarily the same token).
   */
  signed: string;
  /** The viewer that parked it (`viewerIdentity`): a resume must come from the same viewer. */
  identity: string;
  /** The model. */
  model: unknown;
}

/** The HKDF `info` (and the AAD prefix) of a sealed snapshot. */
const SEAL_DOMAIN = "denext.liveview.store.v1";

const sealKeys = /* @__PURE__ */ new Map<string, Promise<CryptoKey>>();

/** The AES-GCM key derived from the view secret (cached per secret). */
function sealKey(): Promise<CryptoKey> {
  const secret = liveViewSecret();
  let key = sealKeys.get(secret);
  if (!key) {
    const enc = new TextEncoder();
    key = crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"])
      .then((base) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: enc.encode(SEAL_DOMAIN) },
          base,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        )
      );
    sealKeys.set(secret, key);
  }
  return key;
}

const aad = (id: string) => new TextEncoder().encode(`${SEAL_DOMAIN}\0${id}`);

/**
 * Seal a snapshot for instance `id`.
 *
 * @param id The instance id it is stored under (bound into the ciphertext).
 * @param snapshot The view, its signed props and the model.
 * @returns The sealed text.
 * @throws {TypeError} When the model holds something the wire codec cannot encode.
 */
export async function sealViewSnapshot(id: string, snapshot: ViewSnapshot): Promise<string> {
  const wire = prepareWire(snapshot.model);
  const plain = JSON.stringify({
    v: snapshot.view,
    s: snapshot.signed,
    i: snapshot.identity,
    m: wire.value ?? null,
    ...(wire.tagged ? { t: 1 } : {}),
  });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(id) },
    await sealKey(),
    new TextEncoder().encode(plain),
  );
  const out = new Uint8Array(12 + cipher.byteLength);
  out.set(iv);
  out.set(new Uint8Array(cipher), 12);
  return toBase64Url(out);
}

/**
 * Open a sealed snapshot of instance `id`.
 *
 * @param id The instance id it was stored under.
 * @param sealed The sealed text.
 * @returns The snapshot, or `null` when it does not open (another secret, another id, tampered).
 */
export async function openViewSnapshot(id: string, sealed: string): Promise<ViewSnapshot | null> {
  try {
    const bytes = new Uint8Array(fromBase64Url(sealed));
    if (bytes.length < 13) return null;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: aad(id) },
      await sealKey(),
      bytes.subarray(12),
    );
    const o = JSON.parse(new TextDecoder().decode(plain));
    if (typeof o?.v !== "string" || typeof o.s !== "string" || typeof o.i !== "string") return null;
    return { view: o.v, signed: o.s, identity: o.i, model: o.t === 1 ? decodeWire(o.m) : o.m };
  } catch {
    return null;
  }
}
