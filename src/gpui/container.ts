/**
 * One window's native tree as the renderer sees it: the batch being built, the node ids (handed
 * out by JS, never reused), the live nodes, and the commit to the window's `nativeTree`.
 *
 * Ops a React commit makes accumulate in {@linkcode GpuiContainer.writer} and go to the host in
 * one `nativeTree.commit` from the host config's `resetAfterCommit`. Work that finishes outside a
 * commit (an image fetched, a controlled input put back) goes in a batch of its own
 * ({@linkcode GpuiContainer.commitAside}). Such work only touches nodes the host already has: a
 * node is sent in the same commit that first attaches it.
 *
 * @module
 */

import { BatchWriter } from "./encoder.ts";
import { ImageStore } from "./images.ts";
import type { GpuiNode } from "./node.ts";

/** A window's native tree API (`Deno.BrowserWindow#nativeTree` on a runtime that has it). */
export interface NativeTreeApi {
  /**
   * Apply one NTB1 batch. 0 is ok, -1 unsupported, -2 a malformed batch (the host keeps the last
   * good tree).
   */
  commit(batch: Uint8Array): number | void;
}

/** The slice of a Deno Desktop window the renderer uses. */
export interface NativeTreeWindow {
  /** The native tree, on a backend that hosts one (the `gpui` backend). */
  readonly nativeTree?: NativeTreeApi;
  /** Subscribe to a window event (the native tree's events arrive as one). */
  addEventListener(type: string, listener: (event: Event) => void): void;
  /** Unsubscribe. */
  removeEventListener?(type: string, listener: (event: Event) => void): void;
}

/** What a container needs from its root. */
export interface ContainerOptions {
  /** Called with an error a commit or an event handler raised (default: `console.error`). */
  readonly onError?: (error: unknown) => void;
  /** The `fetch` images are loaded with (default: the global one). */
  readonly fetch?: typeof fetch;
  /** The base relative image URIs resolve against. */
  readonly assetBase?: string | URL;
}

/** A commit the host refused. */
export class NativeTreeCommitError extends Error {
  /** The host's return code (-1 unsupported, -2 malformed, -3 no such window). */
  readonly code: number;

  /**
   * An error for a refused batch.
   *
   * @param code The host's return code.
   */
  constructor(code: number) {
    super(
      code === -1
        ? "denext/gpui: the window does not support the native tree (nativeTree.commit returned -1)"
        : code === -3
        ? "denext/gpui: the window is gone (nativeTree.commit returned -3)"
        : `denext/gpui: the host rejected a batch (nativeTree.commit returned ${code})`,
    );
    this.name = "NativeTreeCommitError";
    this.code = code;
  }
}

/**
 * A batch the host rejected on its UI thread (a tree-level fault: an unknown node, a cycle, a bad
 * `before`), reported by its `batchError` event. The tree stays at the last good batch.
 */
export class NativeTreeBatchError extends Error {
  /** The rejected batch's sequence number. */
  readonly seq: number;

  /**
   * An error for a rejected batch.
   *
   * @param seq The batch's sequence number.
   * @param reason The host's message.
   */
  constructor(seq: number, reason: string) {
    super(`denext/gpui: the host rejected batch ${seq}: ${reason}`);
    this.name = "NativeTreeBatchError";
    this.seq = seq;
  }
}

/** One window's tree (see the module docs). */
export class GpuiContainer {
  /** The window. */
  readonly window: NativeTreeWindow;
  /** The options the root was rendered with. */
  readonly options: ContainerOptions;
  /** The batch the current React commit is building. */
  readonly writer: BatchWriter = new BatchWriter();
  /** The nodes the host has (materialized and not yet destroyed), by id. */
  readonly nodes: Map<number, GpuiNode> = new Map();
  /** The root view every top-level child is inserted into (set by `createGpuiContainer`). */
  root: GpuiNode | null = null;
  /** The window's images. */
  readonly images: ImageStore = new ImageStore(this);
  #nextId = 1;
  #nextImageId = 1;
  #seq = 0;

  /**
   * @param window The window.
   * @param options The root's options.
   */
  constructor(window: NativeTreeWindow, options: ContainerOptions = {}) {
    this.window = window;
    this.options = options;
  }

  /** A fresh node id (never reused in this window). */
  allocId(): number {
    return this.#nextId++;
  }

  /** A fresh image id (never reused in this window). */
  allocImageId(): number {
    return this.#nextImageId++;
  }

  /** Report an error from a commit or a handler. */
  reportError(error: unknown): void {
    (this.options.onError ?? console.error)(error);
  }

  /** Send `writer`'s batch (when it has ops). */
  #send(writer: BatchWriter): void {
    if (writer.opCount === 0) return;
    const batch = writer.finish(++this.#seq);
    try {
      const code = this.window.nativeTree?.commit(batch);
      if (typeof code === "number" && code < 0) this.reportError(new NativeTreeCommitError(code));
    } catch (error) {
      this.reportError(error);
    }
  }

  /** Send the pending batch: the end of a React commit. */
  commit(): void {
    this.#send(this.writer);
  }

  /**
   * Send ops made outside a React commit in a batch of their own, now.
   *
   * @param write Appends the ops.
   */
  commitAside(write: (writer: BatchWriter) => void): void {
    const writer = new BatchWriter(256);
    write(writer);
    this.#send(writer);
  }
}
