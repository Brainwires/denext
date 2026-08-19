/**
 * `useWakeLock` — a React-style hook over the Screen Wake Lock API
 * (`navigator.wakeLock`) that keeps the display awake (video players, recipe
 * steps, dashboards, scanners). Client-only, and a graceful no-op during SSR or
 * where the API is unavailable.
 *
 * The screen is a single, device-global resource, so this hook is a **hybrid**:
 * each instance owns its own claim (`request`/`release`/its own `released`) and
 * composes safely, but the underlying browser lock is a **refcounted singleton**
 * — the screen stays awake while *any* instance holds a claim, and a single real
 * `WakeLockSentinel` is acquired once and released when the last claim drops. All
 * instances also share the global reads `count`/`active` (via
 * `useSyncExternalStore`) and a `releaseAll()` kill-switch.
 *
 * Next.js ships no wake-lock API; the base surface mirrors the community React
 * hook (`react-screen-wake-lock`): `{ isSupported, released, request, release }`.
 *
 * @module
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from "./hooks.ts";

/** Options for {@linkcode useWakeLock}. */
export interface UseWakeLockOptions {
  /** Called when acquiring the underlying screen lock throws. */
  onError?: (error: Error) => void;
}

/** The controls returned by {@linkcode useWakeLock}. */
export interface WakeLockControls {
  /** Whether the Screen Wake Lock API is available (secure context + browser support). */
  isSupported: boolean;
  /**
   * This instance's claim: `undefined` before its first {@linkcode request},
   * `false` while its claim is held, and `true` once its claim has been dropped
   * (by {@linkcode release}, {@linkcode releaseAll}, or unmount).
   */
  released: boolean | undefined;
  /** Whether the screen is currently held awake by *any* claim (global). */
  active: boolean;
  /** The number of active claims across all instances (global). */
  count: number;
  /** Add this instance's claim, keeping the display on. Idempotent per instance. */
  request: (type?: WakeLockType) => Promise<void>;
  /** Drop *this instance's* claim. The screen sleeps only when the last claim goes. */
  release: () => Promise<void>;
  /** Drop *every* claim across all instances and sleep the screen (global kill-switch). */
  releaseAll: () => Promise<void>;
}

// ---- Refcounted singleton manager ------------------------------------------
// One real WakeLockSentinel is shared by every hook instance; `claims` refcounts
// who wants it. A snapshot object ({ isSupported, count }) is published to
// subscribers so useSyncExternalStore keeps all instances in agreement.

/** Immutable global snapshot read by every hook instance. */
interface WakeSnapshot {
  readonly isSupported: boolean;
  readonly count: number;
}

const claims = new Set<symbol>();
const subscribers = new Set<() => void>();
let sentinel: WakeLockSentinel | null = null;
let lastType: WakeLockType = "screen";
let supported = false;
let visibilityWired = false;
let snapshot: WakeSnapshot = { isSupported: false, count: 0 };
const SERVER_SNAPSHOT: WakeSnapshot = { isSupported: false, count: 0 };

/** `navigator.wakeLock` if the API exists here. */
function wakeLockApi(): WakeLock | undefined {
  return typeof navigator !== "undefined"
    ? (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock
    : undefined;
}

/** Rebuild the published snapshot and notify subscribers. */
function publish(): void {
  snapshot = { isSupported: supported, count: claims.size };
  for (const cb of subscribers) cb();
}

/** Is the Screen Wake Lock API usable right now (client + secure context)? */
function isUsable(): boolean {
  return typeof document !== "undefined" && !!wakeLockApi();
}

/** Recompute support and publish if it changed. */
function checkSupport(): void {
  const s = isUsable();
  if (s !== supported) {
    supported = s;
    publish();
  }
}

/** Acquire the shared sentinel if it isn't currently held. */
async function acquireSentinel(): Promise<void> {
  if (sentinel && !sentinel.released) return;
  const api = wakeLockApi();
  if (!api) return;
  const s = await api.request(lastType);
  sentinel = s;
  // If the browser releases the lock (tab hidden), reflect it; the
  // visibilitychange handler re-acquires when the page returns to visible.
  s.addEventListener("release", publish);
}

/** Release the shared sentinel if held. */
async function releaseSentinel(): Promise<void> {
  const s = sentinel;
  sentinel = null;
  if (s && !s.released) {
    try {
      await s.release();
    } catch { /* already gone */ }
  }
}

/** One shared listener that re-acquires the lock when the page becomes visible. */
function wireVisibility(): void {
  if (visibilityWired || typeof document === "undefined") return;
  visibilityWired = true;
  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState === "visible" && claims.size > 0 && (!sentinel || sentinel.released)
    ) {
      void acquireSentinel().then(publish).catch(() => {});
    }
  });
}

async function addClaim(
  id: symbol,
  type: WakeLockType,
  onError?: (error: Error) => void,
): Promise<void> {
  wireVisibility();
  lastType = type;
  const isNew = !claims.has(id);
  claims.add(id);
  if (isNew) publish(); // count changed
  try {
    await acquireSentinel();
  } catch (error) {
    onError?.(error as Error);
  }
}

async function removeClaim(id: symbol): Promise<void> {
  if (!claims.delete(id)) return; // this instance held no claim
  publish();
  if (claims.size === 0) await releaseSentinel();
}

async function releaseAllClaims(): Promise<void> {
  if (claims.size === 0 && !sentinel) return;
  claims.clear();
  publish();
  await releaseSentinel();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => void subscribers.delete(cb);
}

/**
 * Keep the screen awake via the Screen Wake Lock API, as a hook. Call
 * {@linkcode WakeLockControls.request request} to add this instance's claim and
 * {@linkcode WakeLockControls.release release} to drop it; the claim is also
 * dropped automatically on unmount. Because the screen is device-global, the
 * lock is refcounted: it stays on while any instance has a claim, and
 * {@linkcode WakeLockControls.count count}/{@linkcode WakeLockControls.active active}
 * report the shared state to every instance. {@linkcode WakeLockControls.releaseAll releaseAll}
 * drops every claim at once.
 *
 * The lock is re-acquired automatically when the page returns to visible (the
 * browser drops it while the tab is hidden). On the server, or in a browser
 * without the API, `isSupported` is `false` and the actions are no-ops.
 *
 * @param options Optional `onError` for surfacing acquire failures.
 * @returns {@linkcode WakeLockControls}.
 * @example Keep the screen on while a "cook mode" is active:
 * ```tsx
 * "use client";
 * import { useWakeLock } from "denext";
 *
 * export function CookMode() {
 *   const wake = useWakeLock();
 *   return wake.released === false
 *     ? <button onClick={() => wake.release()}>Let screen sleep</button>
 *     : <button disabled={!wake.isSupported} onClick={() => wake.request()}>
 *         Keep screen on ({wake.count} active)
 *       </button>;
 * }
 * ```
 */
export function useWakeLock(options: UseWakeLockOptions = {}): WakeLockControls {
  const idRef = useRef<symbol | null>(null);
  if (idRef.current === null) idRef.current = Symbol("denext.wakeLock");
  const id = idRef.current;

  const opts = useRef(options);
  opts.current = options;
  const requested = useRef(false);

  const snap = useSyncExternalStore(subscribe, () => snapshot, () => SERVER_SNAPSHOT);

  useEffect(() => {
    checkSupport();
    return () => void removeClaim(id); // drop this instance's claim on unmount
  }, [id]);

  const request = useCallback(
    (type: WakeLockType = "screen") => {
      if (!isUsable()) return Promise.resolve(); // no-op: SSR / unsupported
      requested.current = true;
      return addClaim(id, type, opts.current.onError);
    },
    [id],
  );
  const release = useCallback(() => removeClaim(id), [id]);
  const releaseAll = useCallback(() => releaseAllClaims(), []);

  // Re-derived on every published change (add/remove/releaseAll all change count).
  const claimActive = claims.has(id);
  const released = !requested.current ? undefined : !claimActive;

  return {
    isSupported: snap.isSupported,
    released,
    active: snap.count > 0,
    count: snap.count,
    request,
    release,
    releaseAll,
  };
}
