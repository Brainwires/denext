// The Edge Function worker: one Deno Worker per function, started by `functions.ts`. It loads the
// function's module the way Supabase's edge runtime does — a module that calls
// `Deno.serve(handler)` (any of its call shapes), or one that default-exports a handler (a
// function, or an object with `fetch`) — then answers the requests the host posts to it.
//
// Requests arrive buffered (method, URL, headers, body bytes). Responses go back streamed: a
// `head` message, then `chunk` messages as the function's body produces them, then `end` — so
// a server-sent-events function streams. The host aborts a request (client gone, timeout) with
// an `abort` message, which aborts the `Request.signal` the function sees.
//
// `Deno.env` reads the host's overlay first (`SUPABASE_URL`, `SUPABASE_DB_URL` and the
// function's configured `env`), then the process environment. `EdgeRuntime.waitUntil` is
// accepted (the worker stays up, so the promise runs to completion).

/// <reference lib="deno.worker" />

import type { HostMessage, WorkerMessage } from "./functions-protocol.ts";

type Handler = (request: Request, info: unknown) => Response | Promise<Response>;
type ErrorHandler = (error: unknown) => Response | Promise<Response>;

let handler: Handler | undefined;
let onError: ErrorHandler | undefined;
const inflight = new Map<number, AbortController>();

function post(message: WorkerMessage, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

/** A stand-in for the server `Deno.serve` returns: the function never listens itself. */
function fakeServer(): unknown {
  const finished = new Promise<void>(() => {});
  return {
    finished,
    addr: { transport: "tcp", hostname: "0.0.0.0", port: 8000 },
    shutdown: () => Promise.resolve(),
    ref() {},
    unref() {},
    [Symbol.asyncDispose]: () => Promise.resolve(),
  };
}

/** `Deno.serve`'s call shapes: `(handler)`, `(options, handler)`, `({ handler, ... })`. */
function captureServe(...args: unknown[]): unknown {
  const [first, second] = args;
  const options = (typeof first === "object" && first !== null ? first : {}) as {
    handler?: Handler;
    onError?: ErrorHandler;
  };
  const fn = typeof first === "function"
    ? first as Handler
    : typeof second === "function"
    ? second as Handler
    : options.handler;
  if (typeof fn !== "function") throw new TypeError("Deno.serve: a handler is required");
  handler = fn;
  onError = typeof options.onError === "function" ? options.onError : undefined;
  return fakeServer();
}

/** Overlay `env` on `Deno.env` (reads only; writes go to the process environment). */
function overlayEnv(env: Record<string, string>): void {
  const real = Deno.env;
  const get = real.get.bind(real);
  const has = real.has.bind(real);
  const toObject = real.toObject.bind(real);
  const read = (key: string): string | undefined => {
    if (Object.hasOwn(env, key)) return env[key];
    try {
      return get(key);
    } catch {
      return undefined;
    }
  };
  Object.defineProperty(real, "get", { value: read, configurable: true });
  Object.defineProperty(real, "has", {
    value: (key: string) =>
      Object.hasOwn(env, key) || (() => {
        try {
          return has(key);
        } catch {
          return false;
        }
      })(),
    configurable: true,
  });
  Object.defineProperty(real, "toObject", {
    value: () => {
      let base: Record<string, string> = {};
      try {
        base = toObject();
      } catch {
        // Without env permission the overlay is all there is.
      }
      return { ...base, ...env };
    },
    configurable: true,
  });
}

/** The handler a module provides: `Deno.serve`'s, else its default export. */
function handlerOf(mod: Record<string, unknown>): Handler | undefined {
  if (handler) return handler;
  const fallback = mod.default as unknown;
  if (typeof fallback === "function") return fallback as Handler;
  const fetch = (fallback as { fetch?: unknown } | undefined)?.fetch;
  if (typeof fetch === "function") return (fetch as Handler).bind(fallback);
  return undefined;
}

async function init(module: string, env: Record<string, string>): Promise<void> {
  overlayEnv(env);
  Object.defineProperty(Deno, "serve", { value: captureServe, configurable: true, writable: true });
  (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime = {
    waitUntil(promise: Promise<unknown>) {
      Promise.resolve(promise).catch((error) => console.error(error));
    },
  };
  try {
    const mod = await import(module);
    const found = handlerOf(mod);
    if (!found) {
      post({
        t: "fail",
        message: "the module neither calls Deno.serve(handler) nor default-exports a handler",
      });
      return;
    }
    handler = found;
    post({ t: "ready" });
  } catch (error) {
    post({
      t: "fail",
      message: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
}

async function respond(id: number, response: Response): Promise<void> {
  post({
    t: "head",
    id,
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers],
  });
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!inflight.has(id)) {
          await reader.cancel();
          return;
        }
        const copy = value.slice();
        post({ t: "chunk", id, data: copy }, [copy.buffer]);
      }
    } catch (error) {
      post({ t: "error", id, message: String(error) });
      return;
    }
  }
  post({ t: "end", id });
}

async function serve(message: Extract<HostMessage, { t: "req" }>): Promise<void> {
  const controller = new AbortController();
  inflight.set(message.id, controller);
  try {
    const request = new Request(message.url, {
      method: message.method,
      headers: message.headers,
      body: message.body,
      signal: controller.signal,
    });
    const info = {
      remoteAddr: { transport: "tcp", hostname: message.remote ?? "127.0.0.1", port: 0 },
      completed: Promise.resolve(),
    };
    let response: Response;
    try {
      response = await handler!(request, info);
    } catch (error) {
      if (!onError) throw error;
      response = await onError(error);
    }
    if (!(response instanceof Response)) {
      throw new TypeError("the function's handler did not return a Response");
    }
    await respond(message.id, response);
  } catch (error) {
    console.error(error);
    post({
      t: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    inflight.delete(message.id);
  }
}

self.onmessage = (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.t === "init") void init(message.module, message.env);
  else if (message.t === "req") void serve(message);
  else if (message.t === "abort") {
    inflight.get(message.id)?.abort(new DOMException("the request was aborted", "AbortError"));
    inflight.delete(message.id);
  }
};
