// The live-reload channel: an SSE stream per open page, fed by refresh/reload/css frames,
// per-module HMR updates, and enriched error frames for the dev overlay. Every frame is
// also recorded in the dev black box.

import { relative } from "@std/path";
import { codeframe, parseStackFrame } from "../dev-codeframe.ts";
import { sseSend, sseStream } from "../sse.ts";
import type { DevState } from "./state.ts";

/** The `error:` frame payload the overlay renders. */
export interface ErrorPayload {
  title: string;
  message: string;
  stack: string;
  /** The first in-project stack frame (clickable → open-in-editor), if any. */
  frame?: { file: string; display: string; line: number; column: number };
  /** A source snippet around the frame, with a caret at the error column. */
  codeframe?: string;
}

/** Send one SSE `data:` frame to every subscriber, dropping closed streams. */
function send(st: DevState, data: string): void {
  sseSend(st.reloadClients, data);
}

/**
 * Notify subscribers of a change. `kind` is "refresh" for a Fast Refresh attempt
 * (source-only edits — the client re-imports the route entry, keeping state), "css" for a
 * stylesheet hot-swap, or "reload" for a full reload (assets/config, or anything the
 * refresh can't handle). The client falls back to a full reload on its own if a refresh
 * turns out to be unsafe.
 */
export function broadcast(st: DevState, kind: "refresh" | "reload" | "css"): void {
  st.devEvents.record({
    kind: "hmr",
    ts: Date.now(),
    source: "server",
    level: "info",
    message: kind,
  });
  send(st, kind);
}

/**
 * Push a per-module HMR update: an `update:<json>` frame whose payload is the JSON list of
 * changed accept-boundary module URLs (each cache-busted). The client re-imports only
 * those and re-renders in place (unbundled dev loop).
 */
export function broadcastUpdate(st: DevState, urls: string[]): void {
  st.devEvents.record({
    kind: "hmr",
    ts: Date.now(),
    source: "server",
    level: "info",
    message: `update: ${urls.length} module(s)`,
  });
  send(st, `update:${JSON.stringify(urls)}`);
}

/**
 * Enrich a stack/diagnostic string with the first in-project frame and a codeframe (read
 * from disk). Returns `{}` when no app frame is found, so a framework-only trace just
 * shows message + stack.
 */
export function enrichFrame(
  st: DevState,
  stack: string,
): Pick<ErrorPayload, "frame" | "codeframe"> {
  const f = parseStackFrame(stack, st.paths.projectDir);
  if (!f) return {};
  const frame = {
    file: f.file,
    display: relative(st.paths.projectDir, f.file),
    line: f.line,
    column: f.column,
  };
  try {
    return { frame, codeframe: codeframe(Deno.readTextFileSync(f.file), f.line, f.column) };
  } catch {
    return { frame }; // file vanished / unreadable — still link the frame
  }
}

/** Push an `error:<json>` frame to subscribers, recording it in the black box too. */
export function pushError(st: DevState, payload: ErrorPayload): void {
  st.devEvents.record({
    kind: "error",
    ts: Date.now(),
    source: "server",
    level: "error",
    title: payload.title,
    message: payload.message,
    stack: payload.stack || undefined,
    frame: payload.frame,
    codeframe: payload.codeframe,
  });
  send(st, `error:${JSON.stringify(payload)}`);
}

/**
 * Push a build/bundle/SSR error to the dev error overlay, enriched with the first
 * in-project stack frame + a codeframe so the developer can jump straight to the line.
 */
export function broadcastError(st: DevState, title: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? err.stack : "";
  pushError(st, { title, message, stack, ...enrichFrame(st, stack) });
}

/** The SSE response for a new live-reload subscriber. */
export function reloadStream(st: DevState): Response {
  return sseStream(st.reloadClients);
}

/** Close every subscriber stream (shutdown). */
export function closeReloadClients(st: DevState): void {
  for (const controller of st.reloadClients) {
    try {
      controller.close();
    } catch { /* already closed */ }
  }
  st.reloadClients.clear();
}
