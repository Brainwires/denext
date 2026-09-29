// A REAL desktop runtime for bridge wire tests: `createDesktopHandler` (src/build/desktop.ts)
// wired to a real `createDesktopBridge` over `Deno.serve` on an ephemeral loopback port — the
// same stack `runDesktop` builds, minus the native window. Used by tests/desktop-bridge-wire.test.ts
// (the page-side client in Deno, through a browser-like `fetch` shim) and by
// tests/e2e/desktop-bridge-browser.e2e.test.ts (headless Chromium).

import { join } from "@std/path";
import { createDesktopHandler } from "../../src/build/desktop.ts";
import { createDesktopBridge, type DesktopBridge } from "../../src/desktop/bridge.ts";

/** The bridge's event-stream path (bridge.ts keeps it private). */
const EVENTS_PATH = "/_denext/desktop/events";
import type { DesktopCapability } from "../../src/desktop/extension.ts";

/** One request the server answered (for gate assertions). */
export interface LoggedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly status: number;
}

/** A running real desktop runtime. */
export interface BridgeServer {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** The per-launch token the handler was created with. */
  readonly token: string;
  /** The bridge (to emit events from the "runtime"). */
  readonly bridge: DesktopBridge;
  /** Every answered request, in order. */
  readonly log: LoggedRequest[];
  /** Terminate every open event stream from the runtime side (a dropped connection). */
  dropEventStreams(): void;
  /** How many event streams the server currently holds open. */
  openEventStreams(): number;
  /** Stop the server and remove the export dir. */
  close(): Promise<void>;
}

/** The default shell: a bare document the handler injects `__denext` into. */
const DEFAULT_INDEX = "<!doctype html><html><head><title>bridge</title></head>" +
  '<body><div id="root"></div></body></html>';

/**
 * Start the real handler + bridge on port 0.
 *
 * @param capabilities The enabled capability allowlist.
 * @param opts `indexHtml` (the export's shell) and extra export `files` (path → contents).
 */
export async function startBridgeServer(
  capabilities: readonly DesktopCapability[],
  opts: { indexHtml?: string; files?: Record<string, string> } = {},
): Promise<BridgeServer> {
  const outDir = await Deno.makeTempDir({ prefix: "denext-desktop-bridge-" });
  await Deno.writeTextFile(join(outDir, "index.html"), opts.indexHtml ?? DEFAULT_INDEX);
  for (const [path, body] of Object.entries(opts.files ?? {})) {
    await Deno.writeTextFile(join(outDir, path), body);
  }
  const token = crypto.randomUUID();
  const bridge = createDesktopBridge(capabilities);
  const handle = createDesktopHandler(
    {},
    outDir,
    undefined,
    token,
    undefined,
    undefined,
    false,
    bridge,
  );
  const log: LoggedRequest[] = [];
  const streams = new Set<TransformStreamDefaultController<Uint8Array>>();
  const controller = new AbortController();
  const { promise: listening, resolve } = Promise.withResolvers<number>();
  const server = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    signal: controller.signal,
    onListen: ({ port }) => resolve(port),
  }, async (req) => {
    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    const res = await handle(req, url);
    log.push({ method: req.method, path: url.pathname, headers, status: res.status });
    if (url.pathname !== EVENTS_PATH || !res.ok || !res.body) return res;
    // Route the SSE body through a transform the test can terminate (a dropped connection).
    let ctl!: TransformStreamDefaultController<Uint8Array>;
    const tap = new TransformStream<Uint8Array, Uint8Array>({
      start: (c) => {
        ctl = c;
        streams.add(c);
      },
      flush: () => {
        streams.delete(ctl);
      },
    });
    res.body.pipeTo(tap.writable).catch(() => streams.delete(ctl));
    return new Response(tap.readable, { status: res.status, headers: res.headers });
  });
  const port = await listening;
  const dropEventStreams = () => {
    for (const c of streams) {
      try {
        c.terminate();
      } catch {
        // already closed
      }
    }
    streams.clear();
  };
  return {
    origin: `http://127.0.0.1:${port}`,
    token,
    bridge,
    log,
    dropEventStreams,
    openEventStreams: () => streams.size,
    async close() {
      dropEventStreams();
      controller.abort();
      await server.finished;
      await Deno.remove(outDir, { recursive: true }).catch(() => {});
    },
  };
}

/** The `globalThis.__denext` value the handler injected into `html`, or `undefined`. */
export function injectedGlobal(html: string): Record<string, unknown> | undefined {
  const m = html.match(/<script>globalThis\.__denext=(\{.*?\})(?:;|<\/script>)/);
  return m ? JSON.parse(m[1]) : undefined;
}

/** Wait until `check()` is true, or throw (shared with the fake runtime's tests). */
export { until } from "./desktop-fake-runtime.ts";
