/**
 * Files the OS opens with the app, for `denext/mobile` on Deno Desktop (denext's pinned runtime):
 * a file the app was launched with, one opened with it while it runs (macOS), or one a second
 * launch forwards (`desktop.app.singleInstance`, Windows and Linux). Elsewhere (the web, iOS,
 * Android, the stock desktop runtime) nothing is ever delivered: subscribing is a no-op.
 *
 * Nothing runs at import.
 *
 * @module
 */

import { useEffect, useRef } from "../runtime/hooks.ts";
import { createFanout, type Fanout } from "./link-routing.ts";
import { desktopQueueAttach } from "./desktop-queue.ts";
import type { PickedHandle } from "./filesystem.ts";

/** A file the OS opened with the app. */
export interface OpenedFile {
  /**
   * A READ-ONLY handle to the file: read it with `readFile("", { directory: { picked: handle } })`
   * (needs `denext desktop add fs`). It lasts until the app quits.
   */
  readonly handle: PickedHandle;
  /** The file name. */
  readonly name: string;
  /** The absolute path, for display only: it grants nothing. */
  readonly path: string;
  /** `true` for a file the app was launched with, `false` for one opened while it ran. */
  readonly launch: boolean;
}

let files: Fanout<OpenedFile> | undefined;
/** Files taken while the last subscriber was leaving, for the next one. */
const leftover: OpenedFile[] = [];

/** The page's opened-file fanout, created on first use. */
function openedFiles(): Fanout<OpenedFile> {
  return files ??= createFanout(
    desktopQueueAttach("openFiles", (d) => d.takeDesktopOpenedFiles(), leftover),
  );
}

/**
 * Call `callback` for every file the OS opens with the app (Deno Desktop).
 *
 * Each file is delivered once: one that arrived before anyone subscribed (the file the app was
 * launched with) goes to the first subscriber, so subscribe early (the root layout or app shell);
 * none is replayed after a reload. The OS hands the app a file it was asked to open, which any
 * program of the same user can ask for, so the handle is read-only and the content is untrusted
 * input.
 *
 * @param callback Called with each opened file.
 * @returns A function that unsubscribes.
 * @example
 * ```ts
 * import { onOpenFile, readFile } from "denext/mobile";
 *
 * const stop = onOpenFile(async ({ handle, name }) => {
 *   const text = await readFile("", { directory: { picked: handle } });
 *   openDocument(name, text);
 * });
 * ```
 */
export function onOpenFile(callback: (file: OpenedFile) => void): () => void {
  return openedFiles().subscribe((file) => callback(file));
}

/**
 * Hook form of {@linkcode onOpenFile}: subscribes on mount, unsubscribes on unmount, and calls the
 * latest `callback` (held in a ref, so a fresh closure each render never re-subscribes).
 *
 * @param callback Called with each opened file.
 */
export function useOpenFile(callback: (file: OpenedFile) => void): void {
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => onOpenFile((file) => ref.current(file)), []);
}

/** Forget the page's opened-file state (tests only). */
export function resetOpenFilesForTesting(): void {
  files = undefined;
  leftover.length = 0;
}
