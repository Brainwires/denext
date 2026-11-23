/**
 * Images for the native tree. The host decodes and caches; JavaScript fetches (so the app's own
 * network rules apply), sends each unique source once (IMAGE_DATA), points every Image node
 * showing it at it (SET_IMAGE), and frees it (IMAGE_FREE) when the last of them lets go.
 *
 * A source is anything React Native's `Image.resolveAssetSource` takes: a URL string (an imported
 * image is its URL in a denext build) or `{ uri }`. A relative URL resolves against the root's
 * `assetBase` (default: the working directory). A source that fails to load calls the node's
 * `onError` and `onLoadEnd`.
 *
 * @module
 */

import { toFileUrl } from "@std/path";
import { resolveAssetSource } from "../react-native/image-scale.ts";
import type { GpuiContainer } from "./container.ts";
import type { GpuiNode } from "./node.ts";

/** One source's image. */
interface ImageEntry {
  /** The image id. */
  readonly id: number;
  /** The resolved URL. */
  readonly key: string;
  /** Loading, sent to the host, failed, or freed. */
  state: "loading" | "ready" | "failed" | "freed";
  /** The nodes showing it. */
  readonly nodes: Set<GpuiNode>;
  /** Why it failed. */
  error?: string;
}

/** The MIME type of common image extensions, for a response without `Content-Type`. */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  avif: "image/avif",
};

/**
 * The MIME type to send for `url`: the response's, else its extension's, else
 * `application/octet-stream`.
 *
 * @param url The image URL.
 * @param contentType The response's `Content-Type`, if any.
 * @returns The MIME type.
 */
export function imageMime(url: string, contentType: string | null | undefined): string {
  const declared = contentType?.split(";")[0].trim();
  if (declared) return declared;
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(url)?.[1]?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || "application/octet-stream";
}

/** The base relative URIs resolve against. */
function assetBase(container: GpuiContainer): string | URL {
  return container.options.assetBase ?? toFileUrl(`${Deno.cwd()}/`);
}

/** A node's `onError` then `onLoadEnd`, as React Native calls them. */
function failNode(node: GpuiNode, error: string): void {
  const props = node.props as {
    onError?: (e: unknown) => void;
    onLoadEnd?: () => void;
  };
  try {
    props.onError?.({ nativeEvent: { error }, target: node.id });
    props.onLoadEnd?.();
  } catch (e) {
    node.container.reportError(e);
  }
}

/** One window's images (see the module docs). */
export class ImageStore {
  readonly #container: GpuiContainer;
  readonly #entries = new Map<string, ImageEntry>();

  /** @param container The window's tree. */
  constructor(container: GpuiContainer) {
    this.#container = container;
  }

  /**
   * Show `source` on `node` (an Image), releasing what it showed before. Called from the commit
   * (and from CREATE's initial props), so its ops go in the pending batch.
   *
   * @param node The Image node.
   * @param source Its `source` prop.
   */
  set(node: GpuiNode, source: unknown): void {
    const uri = resolveAssetSource(source)?.uri;
    const key = uri === undefined ? undefined : this.#resolve(uri);
    if (key === node.imageKey) return;
    // Point the node away from what it showed before that image may be freed.
    if (node.imageKey !== undefined && this.#container.isSent(node.id)) {
      this.#container.writer.setImage(node.id, 0);
    }
    this.release(node);
    if (key !== undefined) this.#show(node, key);
  }

  /** Show the image of `key` on `node`: now when it is ready, else once it loads. */
  #show(node: GpuiNode, key: string): void {
    node.imageKey = key;
    const entry = this.#entries.get(key) ?? this.#load(key);
    entry.nodes.add(node);
    if (entry.state === "ready") this.#container.writer.setImage(node.id, entry.id);
    else if (entry.state === "failed") queueMicrotask(() => failNode(node, entry.error ?? ""));
  }

  /**
   * Let go of `node`'s image: the last node to let go frees it on the host (or drops a fetch
   * still running).
   *
   * @param node The node.
   */
  release(node: GpuiNode): void {
    const key = node.imageKey;
    if (key === undefined) return;
    node.imageKey = undefined;
    const entry = this.#entries.get(key);
    if (!entry) return;
    entry.nodes.delete(node);
    if (entry.nodes.size > 0) return;
    this.#entries.delete(key);
    if (entry.state === "ready") this.#container.writer.imageFree(entry.id);
    entry.state = "freed";
  }

  /** `uri` as an absolute URL string. */
  #resolve(uri: string): string {
    try {
      return new URL(uri, assetBase(this.#container)).href;
    } catch {
      return uri;
    }
  }

  /** Start fetching `key`. */
  #load(key: string): ImageEntry {
    const entry: ImageEntry = {
      id: this.#container.allocImageId(),
      key,
      state: "loading",
      nodes: new Set(),
    };
    this.#entries.set(key, entry);
    const doFetch = this.#container.options.fetch ?? fetch;
    doFetch(key).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      this.#deliver(entry, imageMime(key, res.headers.get("content-type")), bytes);
    }).catch((error) => this.#fail(entry, error));
    return entry;
  }

  /**
   * Send a fetched image: IMAGE_DATA and the SET_IMAGE of every node the host has, in a batch of
   * their own; a node whose CREATE is still pending gets its SET_IMAGE in the pending batch.
   */
  #deliver(entry: ImageEntry, mime: string, bytes: Uint8Array): void {
    if (entry.state !== "loading") return;
    entry.state = "ready";
    const container = this.#container;
    const nodes = [...entry.nodes];
    container.commitAside((w) => {
      w.imageData(entry.id, mime, bytes);
      for (const node of nodes) if (container.isSent(node.id)) w.setImage(node.id, entry.id);
    });
    for (const node of nodes) {
      if (!container.isSent(node.id)) container.writer.setImage(node.id, entry.id);
    }
  }

  /** A fetch failed: every node showing it hears `onError`. */
  #fail(entry: ImageEntry, error: unknown): void {
    if (entry.state !== "loading") return;
    entry.state = "failed";
    entry.error = error instanceof Error ? error.message : String(error);
    for (const node of entry.nodes) failNode(node, entry.error);
  }
}
