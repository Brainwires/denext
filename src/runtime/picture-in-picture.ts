/**
 * `usePictureInPicture` — a React-style hook over the Picture-in-Picture API for
 * `<video>` (`requestPictureInPicture` / `document.exitPictureInPicture`). Attach
 * the returned `ref` to a video and drive PiP with `enter` / `exit` / `toggle`.
 * Client-only, and a graceful no-op during SSR or where the API is unavailable.
 *
 * Next.js ships no Picture-in-Picture API, so the surface follows the idiomatic
 * community hook. PiP is a browser singleton (only one video at a time), so —
 * like {@link ../runtime/wake-lock.ts | useWakeLock} — `isActive` is per-element
 * while `isPiPOpen` is the shared global read (via `useSyncExternalStore`).
 *
 * @module
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "./hooks.ts";

/** Options for {@linkcode usePictureInPicture}. */
export interface UsePictureInPictureOptions {
  /** Called when the attached video enters Picture-in-Picture. */
  onEnter?: (window: PictureInPictureWindow) => void;
  /** Called when the attached video leaves Picture-in-Picture. */
  onExit?: () => void;
  /** Called when the PiP window is resized (its `width`/`height` change). */
  onResize?: (window: PictureInPictureWindow) => void;
  /** Called when entering or exiting PiP throws (e.g. no user gesture). */
  onError?: (error: Error) => void;
}

/** The controls returned by {@linkcode usePictureInPicture}. */
export interface PictureInPictureControls {
  /** Attach this callback ref to the `<video>` element you want to control. */
  ref: (el: HTMLVideoElement | null) => void;
  /** Whether the Picture-in-Picture API is available and permitted. */
  isSupported: boolean;
  /** Whether the attached video is currently in Picture-in-Picture. */
  isActive: boolean;
  /** Whether *any* video is currently in Picture-in-Picture (global singleton). */
  isPiPOpen: boolean;
  /** The PiP window (with `width`/`height`) while the attached video is in PiP, else `null`. */
  pipWindow: PictureInPictureWindow | null;
  /** Enter PiP for the attached video. Must be called from a user gesture. */
  enter: () => Promise<void>;
  /** Exit PiP if the attached video is the one in Picture-in-Picture. */
  exit: () => Promise<void>;
  /** Enter PiP if the attached video isn't in it, otherwise exit. */
  toggle: () => Promise<void>;
}

// ---- Global singleton state (only one PiP video at a time) ------------------

interface PiPSnapshot {
  readonly isSupported: boolean;
  readonly active: HTMLVideoElement | null;
}

const subscribers = new Set<() => void>();
let supported = false;
let active: HTMLVideoElement | null = null;
let snapshot: PiPSnapshot = { isSupported: false, active: null };
const SERVER_SNAPSHOT: PiPSnapshot = { isSupported: false, active: null };

/** Is the Picture-in-Picture API usable right now (client + enabled)? */
function isUsable(): boolean {
  return typeof document !== "undefined" && document.pictureInPictureEnabled === true;
}

function publish(): void {
  snapshot = { isSupported: supported, active };
  for (const cb of subscribers) cb();
}

function checkSupport(): void {
  const s = isUsable();
  if (s !== supported) {
    supported = s;
    publish();
  }
}

/** Record which video (if any) is the current PiP element and notify subscribers. */
function setActive(el: HTMLVideoElement | null): void {
  if (active === el) return;
  active = el;
  publish();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => void subscribers.delete(cb);
}

/**
 * Control Picture-in-Picture for a `<video>` as a hook. Spread the returned
 * {@linkcode PictureInPictureControls.ref ref} onto the video, then call
 * {@linkcode PictureInPictureControls.enter enter} /
 * {@linkcode PictureInPictureControls.exit exit} /
 * {@linkcode PictureInPictureControls.toggle toggle} (from a click — the browser
 * requires a user gesture to enter PiP). {@linkcode PictureInPictureControls.isActive isActive}
 * tracks *this* video; {@linkcode PictureInPictureControls.isPiPOpen isPiPOpen} is the
 * shared global state. On the server, or without the API, `isSupported` is
 * `false` and the actions are no-ops.
 *
 * @param options Enter/exit/resize/error callbacks.
 * @returns {@linkcode PictureInPictureControls}.
 * @example A PiP toggle button on a video:
 * ```tsx
 * "use client";
 * import { usePictureInPicture } from "denext";
 *
 * export function Player({ src }: { src: string }) {
 *   const pip = usePictureInPicture();
 *   return (
 *     <>
 *       <video ref={pip.ref} src={src} controls />
 *       <button disabled={!pip.isSupported} onClick={() => pip.toggle()}>
 *         {pip.isActive ? "Exit" : "Pop out"}
 *       </button>
 *     </>
 *   );
 * }
 * ```
 */
export function usePictureInPicture(
  options: UsePictureInPictureOptions = {},
): PictureInPictureControls {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pipWinRef = useRef<PictureInPictureWindow | null>(null);
  const [pipWindow, setPipWindow] = useState<PictureInPictureWindow | null>(null);
  const opts = useRef(options);
  opts.current = options;

  const snap = useSyncExternalStore(subscribe, () => snapshot, () => SERVER_SNAPSHOT);

  const onResize = useRef((): void => {
    const win = pipWinRef.current;
    if (win) opts.current.onResize?.(win);
  }).current;

  const onEnter = useRef((event: Event): void => {
    const win = (event as PictureInPictureEvent).pictureInPictureWindow;
    setActive(videoRef.current);
    pipWinRef.current = win;
    setPipWindow(win);
    win.addEventListener("resize", onResize);
    opts.current.onEnter?.(win);
  }).current;

  const onLeave = useRef((): void => {
    if (active === videoRef.current) setActive(null);
    const win = pipWinRef.current;
    if (win) win.removeEventListener("resize", onResize);
    pipWinRef.current = null;
    setPipWindow(null);
    opts.current.onExit?.();
  }).current;

  const ref = useCallback((el: HTMLVideoElement | null) => {
    const prev = videoRef.current;
    if (prev === el) return;
    if (prev) {
      prev.removeEventListener("enterpictureinpicture", onEnter);
      prev.removeEventListener("leavepictureinpicture", onLeave);
      if (active === prev) setActive(null);
    }
    videoRef.current = el;
    if (el) {
      el.addEventListener("enterpictureinpicture", onEnter);
      el.addEventListener("leavepictureinpicture", onLeave);
    }
  }, [onEnter, onLeave]);

  const enter = useCallback(async (): Promise<void> => {
    const video = videoRef.current;
    if (!video || !isUsable()) return; // no-op: SSR / unsupported
    if (document.pictureInPictureElement === video) return; // already in PiP
    try {
      await video.requestPictureInPicture(); // fires "enterpictureinpicture"
    } catch (error) {
      opts.current.onError?.(error as Error);
    }
  }, []);

  const exit = useCallback(async (): Promise<void> => {
    if (typeof document === "undefined") return;
    if (document.pictureInPictureElement && document.pictureInPictureElement === videoRef.current) {
      try {
        await document.exitPictureInPicture(); // fires "leavepictureinpicture"
      } catch (error) {
        opts.current.onError?.(error as Error);
      }
    }
  }, []);

  const toggle = useCallback((): Promise<void> => {
    const video = videoRef.current;
    return typeof document !== "undefined" && document.pictureInPictureElement === video
      ? exit()
      : enter();
  }, [enter, exit]);

  useEffect(() => {
    checkSupport();
    return () => {
      // On unmount the callback ref already detaches the video's PiP listeners, but
      // if the component unmounts WHILE still in PiP, `leavepictureinpicture` never
      // fires — so the `resize` listener added on the PiP window (pip:144) would
      // leak. Remove it here too, and drop any stale global claim this video held.
      const win = pipWinRef.current;
      if (win) win.removeEventListener("resize", onResize);
      pipWinRef.current = null;
      if (active === videoRef.current) setActive(null);
    };
  }, []);

  return {
    ref,
    isSupported: snap.isSupported,
    isActive: snap.active === videoRef.current && videoRef.current !== null,
    isPiPOpen: snap.active !== null,
    pipWindow,
    enter,
    exit,
    toggle,
  };
}
