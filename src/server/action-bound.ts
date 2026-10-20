// Bound Server Actions: an inline `"use server"` function that reads its component's values, and
// `action.bind(null, value)` — Next.js's encrypted closures, server-only.
//
// A bound action is the registered action plus values only the server may read. Its reference id
// is `<action id>.<token>`, where the token is the values sealed with AES-GCM under a server key:
// the form's `action` URL, the Flight reference and the client stub all carry the id as an opaque
// string, so nothing in the browser changes. The endpoint opens the token and calls the action
// with the values first, then the caller's arguments.
//
// SECURITY
// - Confidentiality and integrity: AES-GCM (a 16-byte tag, required at its full length) under a
//   key the browser never sees. A token the client edits, truncates or forges fails to open, and
//   the request is answered as an unknown action.
// - No replay across actions: the token's additional data is the action id it was sealed for,
//   so a token lifted from one action's form never opens for another. Replaying a token for its
//   own action is a resubmission of that form (as in Next.js): the action must still authorize
//   the caller and validate its input.
// - The key: `DENEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (or Next.js's
//   `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`), base64 of 16, 24 or 32 bytes, when set — every
//   instance behind one load balancer must share it; else the key `denext build` generated
//   (a new one per build, recorded in the server-only `manifest.json`); else one random key per
//   process (`denext dev`, a server with no build). A token sealed under another key — an older
//   build's page, another instance — fails to open.
// - Values go through the wire codec (JSON plus Date, Map, Set, BigInt, URL, …); a function or
//   class instance can't be bound, and rendering one fails with the action named.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import { envGet } from "../runtime/env-safe.ts";
import { decodeWire, prepareWire } from "../runtime/wire-codec.ts";
import {
  registerServerReference,
  type ServerActionRef,
  setServerReferenceDecorator,
  unregisterServerReference,
} from "../runtime/server-action.ts";
import { processShared } from "../runtime/process-shared.ts";

/** The environment variable that sets the key (Next.js's name is read too). */
export const ACTIONS_KEY_ENV = "DENEXT_SERVER_ACTIONS_ENCRYPTION_KEY";
const NEXT_ACTIONS_KEY_ENV = "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY";

/** Separates an action id from its bound values' token (absent from both alphabets). */
const BOUND_SEPARATOR = ".";
/** The token format's version byte. */
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

type Handler = (...args: unknown[]) => unknown;

/**
 * Inline actions that close over their component's values, by id: registered bound-only, so only
 * a token the server sealed (carrying at least `captures` values) reaches `handler`, whose leading
 * parameters are those values. Never in the plain registry: a request naming the bare id is an
 * unknown action, as Next.js's encrypted closures fail to decrypt without their sealed argument.
 */
const capturingActions = /* @__PURE__ */ processShared(
  "capturingServerActions",
  () => new Map<string, { handler: Handler; captures: number }>(),
);

let buildKey: Uint8Array | null = null;
let processKey: Uint8Array | null = null;

/** The key bytes from base64 text, or a configuration error naming where it came from. */
function parseKey(text: string, source: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(text.trim());
  } catch {
    throw new Error(`denext: ${source} is not base64`);
  }
  if (![16, 24, 32].includes(bytes.length)) {
    throw new Error(
      `denext: ${source} must be base64 of 16, 24 or 32 bytes (got ${bytes.length}); ` +
        "generate one with `openssl rand -base64 32`",
    );
  }
  return bytes;
}

/**
 * Install the key `denext build` generated (`manifest.json`'s `serverActionsKey`), used when no
 * key is set in the environment. `null` forgets it (tests).
 *
 * @param base64 The key, base64; null to clear.
 */
export function setBuildServerActionsKey(base64: string | null): void {
  buildKey = base64 === null ? null : parseKey(base64, "the build's serverActionsKey");
}

/** A fresh random key, base64 (what `denext build` records). */
export function generateServerActionsKey(): string {
  return encodeBase64(randomBytes(32));
}

/** The last environment key parsed, by its text (the env is read on every seal and open). */
let envKey: { text: string; bytes: Uint8Array } | null = null;

/** The key bound values are sealed under (see the module comment for the order). */
function actionsKey(): Uint8Array {
  const name = envGet(ACTIONS_KEY_ENV) ? ACTIONS_KEY_ENV : NEXT_ACTIONS_KEY_ENV;
  const text = envGet(name);
  if (text) {
    if (envKey?.text !== text) envKey = { text, bytes: parseKey(text, name) };
    return envKey.bytes;
  }
  return buildKey ?? (processKey ??= randomBytes(32));
}

/** `aes-<bits>-gcm` for `key`. */
function cipherName(key: Uint8Array): "aes-128-gcm" | "aes-192-gcm" | "aes-256-gcm" {
  return `aes-${key.length * 8}-gcm` as "aes-128-gcm" | "aes-192-gcm" | "aes-256-gcm";
}

/** The additional authenticated data: the action the values were sealed for. */
function aad(actionId: string): Uint8Array {
  return new TextEncoder().encode(`denext-bound-action:${VERSION}:${actionId}`);
}

/**
 * Seal `values` for the action `actionId`: the token its bound reference id carries.
 *
 * @param actionId The action's own id.
 * @param values The values bound before the caller's arguments.
 * @returns The token (base64url).
 * @throws TypeError when a value can't be encoded (a function, a symbol, a cycle).
 */
export function sealBoundValues(actionId: string, values: readonly unknown[]): string {
  const plain = new TextEncoder().encode(JSON.stringify(prepareWire(values).value));
  const key = actionsKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(cipherName(key), key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(actionId));
  const body = new Uint8Array([...cipher.update(plain), ...cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = new Uint8Array(1 + IV_BYTES + body.length + TAG_BYTES);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(body, 1 + IV_BYTES);
  out.set(tag, 1 + IV_BYTES + body.length);
  return encodeBase64Url(out);
}

/**
 * Open a token sealed for `actionId`, or null when it does not open (edited, forged, sealed for
 * another action or under another key, malformed).
 *
 * @param actionId The action the request names.
 * @param token The token from the request's reference id.
 */
export function openBoundValues(actionId: string, token: string): unknown[] | null {
  try {
    const raw = decodeBase64Url(token);
    if (raw.length < 1 + IV_BYTES + TAG_BYTES || raw[0] !== VERSION) return null;
    const key = actionsKey();
    const iv = raw.subarray(1, 1 + IV_BYTES);
    const body = raw.subarray(1 + IV_BYTES, raw.length - TAG_BYTES);
    const decipher = createDecipheriv(cipherName(key), key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(actionId));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const plain = new Uint8Array([...decipher.update(body), ...decipher.final()]);
    const values = decodeWire(JSON.parse(new TextDecoder().decode(plain)));
    return Array.isArray(values) ? values : null;
  } catch {
    return null;
  }
}

/** A bound reference id split into its action id and token, or null for a plain id. */
function splitBoundId(id: string): { actionId: string; token: string } | null {
  const at = id.indexOf(BOUND_SEPARATOR);
  return at === -1 ? null : { actionId: id.slice(0, at), token: id.slice(at + 1) };
}

/**
 * The handler a bound reference id names: the registered action, called with the values its
 * token seals first. Null when `id` is not a bound id, the action is not registered, or the token
 * does not open for it.
 *
 * @param id The requested reference id.
 * @param lookup Finds a registered action by its own id.
 */
export function resolveBoundAction(
  id: string,
  lookup: (actionId: string) => Handler | undefined,
): Handler | null {
  const split = splitBoundId(id);
  if (!split) return null;
  const capturing = capturingActions.get(split.actionId);
  const handler = capturing?.handler ?? lookup(split.actionId);
  if (!handler) return null;
  const values = openBoundValues(split.actionId, split.token);
  // A capturing action's token must carry every value it captures: none may come from the caller.
  if (!values || values.length < (capturing?.captures ?? 0)) return null;
  return (...args: unknown[]) => handler(...values, ...args);
}

/**
 * A reference to `handler` (the action `actionId`) with `values()` bound before the caller's
 * arguments. Its id seals the values on first read, so a value declared after the action in its
 * component is read only once the component has run.
 */
function boundReference(
  actionId: string,
  handler: Handler,
  values: () => readonly unknown[],
  name = handler.name,
): ServerActionRef<unknown[], unknown> {
  let id: string | undefined;
  // One snapshot: what the id seals is what a direct call passes.
  let snapshot: readonly unknown[] | undefined;
  const bound = () => snapshot ??= values();
  const ref = (...args: unknown[]) => Promise.resolve(handler(...bound(), ...args));
  Object.defineProperty(ref, "denextActionId", {
    enumerable: false,
    configurable: true,
    get() {
      if (id !== undefined) return id;
      try {
        id = `${actionId}${BOUND_SEPARATOR}${sealBoundValues(actionId, bound())}`;
      } catch (err) {
        throw new TypeError(
          `denext: a value bound to the Server Action ${name || actionId} can't be sent: ${
            (err as Error).message
          }. Bound values must be JSON-like (strings, ` +
            "numbers, arrays, plain objects, Date, Map, Set, BigInt, URL).",
        );
      }
      return id;
    },
  });
  decorate(ref, actionId, handler, bound);
  return ref as ServerActionRef<unknown[], unknown>;
}

/**
 * Give `ref` (the action `actionId`, bound to `bound()` so far) a `bind` that binds more values,
 * as `Function.prototype.bind` does, keeping it a server reference.
 */
function decorate(
  ref: Handler,
  actionId: string,
  handler: Handler,
  bound: () => readonly unknown[],
): void {
  if (!Object.isExtensible(ref)) return; // a frozen export keeps the native `bind`
  Object.defineProperty(ref, "bind", {
    enumerable: false,
    configurable: true,
    writable: true,
    value(thisArg: unknown, ...more: unknown[]) {
      const call: Handler = (...args) => handler.apply(thisArg, args);
      if (more.length === 0 && bound().length === 0) {
        const plain = (...args: unknown[]) => Promise.resolve(call(...args));
        Object.defineProperty(plain, "denextActionId", { value: actionId, configurable: true });
        decorate(plain, actionId, handler, bound);
        return plain;
      }
      return boundReference(actionId, call, () => [...bound(), ...more]);
    },
  });
}

/** Server references created or tagged from now on get the bound `bind` above. */
setServerReferenceDecorator((fn, id) => decorate(fn, id, fn, () => []));

/**
 * Register an inline `"use server"` function under `id` (the transform's runtime): a server
 * reference whose `bind` binds values as above. One that closes over its component's values
 * (`captures` > 0, its leading parameters) is registered bound-only: only a sealed reference id
 * carrying those values resolves it, never the plain `id`.
 *
 * @param id The build-stable action id.
 * @param handler The hoisted function.
 * @param captures How many leading parameters are captured values (0: a plain action).
 */
// fallow-ignore-next-line unused-export -- imported by the code the inline transform generates
export function inlineServerReference(
  id: string,
  handler: Handler,
  captures = 0,
): ServerActionRef<unknown[], unknown> {
  if (captures <= 0) {
    capturingActions.delete(id);
    return registerServerReference(id, handler);
  }
  capturingActions.set(id, { handler, captures });
  unregisterServerReference(id); // a dev re-import that now captures: the plain id goes away
  const ref = (...args: unknown[]) => Promise.resolve(handler(...args));
  Object.defineProperty(ref, "denextActionId", { value: id, configurable: true });
  decorate(ref, id, handler, () => []);
  return ref as ServerActionRef<unknown[], unknown>;
}

/**
 * The reference an inline action that reads its component's values renders: the registered
 * action `ref` with `values()` (the values it closes over, in the order the hoisted function takes
 * them) bound first.
 *
 * @param ref The registered inline action.
 * @param values Reads the enclosing scope's values.
 * @param name The function's name (for an error naming it).
 */
export function bindInlineAction(
  ref: ServerActionRef<unknown[], unknown>,
  values: () => readonly unknown[],
  name?: string,
): ServerActionRef<unknown[], unknown> {
  return boundReference(ref.denextActionId, ref, values, name);
}
