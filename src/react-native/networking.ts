/**
 * React Native's `Networking` (`RCTNetworking`, the native module behind its `XMLHttpRequest`)
 * for React Native mode, over `fetch`: `sendRequest` reports through the same events, with the
 * same payloads, React Native's networking module emits (`didReceiveNetworkResponse`, then
 * `didReceiveNetworkData`, or with `incrementalUpdates` `didReceiveNetworkIncrementalData` for a
 * text response and `didReceiveNetworkDataProgress` (then the whole body) for a base64 or blob
 * one, then `didCompleteNetworkResponse`), so code written against the module (an SSE or
 * streaming client, a network logger) runs unchanged. `didSendNetworkData` (upload progress) is
 * never emitted: `fetch` does not report it.
 *
 * @module
 */

import { type EmitterSubscription, listeners } from "./internal.ts";

/** The events `Networking.addListener` takes. */
export type NetworkingEvent =
  | "didSendNetworkData"
  | "didReceiveNetworkResponse"
  | "didReceiveNetworkData"
  | "didReceiveNetworkIncrementalData"
  | "didReceiveNetworkDataProgress"
  | "didCompleteNetworkResponse";

/** What `sendRequest` delivers the response as. */
export type NetworkingResponseType = "text" | "base64" | "blob";

/** React Native's `Networking` module. */
export interface NetworkingStatic {
  /** Listen for a networking event; the listener receives the event's argument tuple. */
  addListener(
    eventType: NetworkingEvent,
    listener: (args: unknown[]) => unknown,
    context?: unknown,
  ): EmitterSubscription;
  /**
   * Start a request; `callback` receives its id (the first element of every event's tuple).
   * `timeout` is in ms (0: none); `withCredentials` sends cookies cross-origin.
   */
  sendRequest(
    method: string,
    trackingName: string | undefined,
    url: string,
    headers: Record<string, string>,
    data: unknown,
    responseType: NetworkingResponseType,
    incrementalUpdates: boolean,
    timeout: number,
    callback: (requestId: number) => void,
    withCredentials: boolean,
  ): void;
  /** Cancel a request (no further events for it). */
  abortRequest(requestId: number): void;
  /**
   * Remove the cookies the page can reach (`document.cookie`; `HttpOnly` ones are the
   * browser's), whatever path of the page or domain above it they were set for, then call
   * `callback` with whether any were actually removed.
   */
  clearCookies(callback: (result: boolean) => void): void;
}

/** The event fan-out (each listener gets the tuple). */
const events = listeners<NetworkingEvent, unknown[]>();
/** In-flight requests' abort controllers. */
const inflight = new Map<number, AbortController>();
let nextId = 1;

/** Emit `event` with its tuple. */
function emit(event: NetworkingEvent, ...args: unknown[]): void {
  events.emit(event, args);
}

/**
 * React Native's request body (`{ string }`, `{ formData }`, `{ base64 }`, `{ uri }`, a `Blob`,
 * bytes). A `{ uri }` body is the bytes at that URI, fetched as a `Blob` (a `blob:`, `data:`,
 * `file:` or `http(s):` URL the page can read). Any other shape throws, failing the request.
 */
async function requestBody(data: unknown): Promise<BodyInit | undefined> {
  if (data === null || data === undefined) return undefined;
  if (typeof data === "string") return data;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data;
  if (typeof FormData !== "undefined" && data instanceof FormData) return data;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data as BodyInit;
  const o = data as { string?: string; formData?: FormData; base64?: string; uri?: string };
  if (typeof o.string === "string") return o.string;
  if (o.formData !== undefined) return o.formData;
  if (typeof o.base64 === "string") return Uint8Array.from(atob(o.base64), (c) => c.charCodeAt(0));
  if (typeof o.uri === "string") {
    const file = await fetch(o.uri);
    if (!file.ok) {
      throw new Error(`Could not read the request body from ${o.uri} (${file.status}).`);
    }
    return await file.blob();
  }
  throw new TypeError(
    "Unsupported request body: expected a string, Blob, FormData, bytes, or { string }, " +
      "{ formData }, { base64 } or { uri }.",
  );
}

/** A response's headers as an object. */
function headersOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, key) => (out[key] = value));
  return out;
}

/** Bytes as base64. */
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** Read the body in chunks, reporting each (`incrementalUpdates`). */
async function streamBody(id: number, res: Response): Promise<void> {
  const total = Number(res.headers.get("content-length") ?? -1);
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.byteLength;
    emit(
      "didReceiveNetworkIncrementalData",
      id,
      decoder.decode(value, { stream: true }),
      loaded,
      total,
    );
  }
  const tail = decoder.decode();
  if (tail) emit("didReceiveNetworkIncrementalData", id, tail, loaded, total);
}

/**
 * Read a base64 / blob body in chunks, reporting `didReceiveNetworkDataProgress` (loaded,
 * total) for each as React Native does with `incrementalUpdates`, then the whole body.
 */
async function progressBody(
  id: number,
  res: Response,
  type: NetworkingResponseType,
): Promise<void> {
  const total = Number(res.headers.get("content-length") ?? -1);
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    if (!reader) break;
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    emit("didReceiveNetworkDataProgress", id, loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  if (type === "base64") emit("didReceiveNetworkData", id, toBase64(bytes));
  else {
    const mime = res.headers.get("content-type") ?? "";
    emit("didReceiveNetworkData", id, new Blob([bytes], mime ? { type: mime } : undefined));
  }
}

/** Read the whole body as `responseType` and report it. */
async function wholeBody(id: number, res: Response, type: NetworkingResponseType): Promise<void> {
  if (type === "base64") {
    emit("didReceiveNetworkData", id, toBase64(new Uint8Array(await res.arrayBuffer())));
  } else if (type === "blob") emit("didReceiveNetworkData", id, await res.blob());
  else emit("didReceiveNetworkData", id, await res.text());
}

/** Run request `id`. */
async function run(
  id: number,
  init: RequestInit,
  data: unknown,
  url: string,
  responseType: NetworkingResponseType,
  incremental: boolean,
  timeout: number,
): Promise<void> {
  const controller = inflight.get(id)!;
  let timedOut = false;
  const timer = timeout > 0
    ? setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout)
    : undefined;
  try {
    const body = await requestBody(data);
    if (!inflight.has(id)) return; // aborted while the body was read
    const res = await fetch(url, { ...init, body, signal: controller.signal });
    emit("didReceiveNetworkResponse", id, res.status, headersOf(res), res.url || url);
    if (incremental && responseType === "text") await streamBody(id, res);
    else if (incremental) await progressBody(id, res, responseType);
    else await wholeBody(id, res, responseType);
    if (inflight.has(id)) emit("didCompleteNetworkResponse", id, "", false);
  } catch (err) {
    if (!inflight.has(id)) return; // aborted by abortRequest
    const message = timedOut ? "The request timed out." : String((err as Error)?.message ?? err);
    emit("didCompleteNetworkResponse", id, message, timedOut);
  } finally {
    clearTimeout(timer);
    inflight.delete(id);
  }
}

/** The paths (`/`, `/a`, `/a/`, …) and domains (none, the host, its parents) a page's cookies may have. */
function cookieScopes(): { paths: string[]; domains: (string | undefined)[] } {
  const location = (globalThis as { location?: { pathname?: string; hostname?: string } })
    .location;
  const paths = ["/"];
  let prefix = "";
  for (const segment of (location?.pathname ?? "/").split("/").filter(Boolean)) {
    prefix += `/${segment}`;
    paths.push(prefix, `${prefix}/`);
  }
  const domains: (string | undefined)[] = [undefined];
  const labels = (location?.hostname ?? "").split(".").filter(Boolean);
  // The host and each parent above the top-level label (a cookie cannot be set for a TLD).
  for (let i = 0; i < labels.length - 1; i++) domains.push(labels.slice(i).join("."));
  return { paths, domains };
}

/**
 * React Native's `Networking` over `fetch` (see the module docs). Events arrive as React
 * Native's do: each listener receives one argument, the event's tuple starting with the
 * request id.
 */
export const Networking: NetworkingStatic = {
  addListener(eventType, listener, context) {
    return events.add(eventType, (args) => listener.call(context, args));
  },
  sendRequest(
    method,
    _trackingName,
    url,
    headers,
    data,
    responseType,
    incrementalUpdates,
    timeout,
    callback,
    withCredentials,
  ) {
    const id = nextId++;
    inflight.set(id, new AbortController());
    callback(id);
    const init: RequestInit = {
      method,
      headers,
      credentials: withCredentials ? "include" : "same-origin",
    };
    queueMicrotask(() => void run(id, init, data, url, responseType, incrementalUpdates, timeout));
  },
  abortRequest(requestId) {
    const controller = inflight.get(requestId);
    inflight.delete(requestId);
    controller?.abort();
  },
  clearCookies(callback) {
    const doc = (globalThis as { document?: { cookie?: string } }).document;
    const read = () =>
      (doc?.cookie ?? "").split(";").map((c) => c.split("=")[0].trim()).filter(Boolean);
    const before = read();
    if (doc) {
      // A cookie is removed only by naming the path and domain it was set with, which
      // `document.cookie` does not tell: try every path above the page and every domain above
      // its host (and none, for a host-only cookie).
      const { paths, domains } = cookieScopes();
      for (const name of new Set(before)) {
        for (const path of paths) {
          for (const domain of domains) {
            doc.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${path}` +
              (domain ? `; domain=${domain}` : "");
          }
        }
      }
    }
    callback(read().length < before.length);
  },
};
