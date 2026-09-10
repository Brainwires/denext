/**
 * `useNetworkState` — online/offline status plus the Network Information API's
 * connection hints (`effectiveType`, `downlink`, `rtt`, `saveData`) where the
 * browser exposes them. Client-only; reports `{ online: true }` during SSR.
 *
 * @module
 */

import { useCallback, useSyncExternalStore } from "../runtime/hooks.ts";

/** Network status, with connection hints when the browser provides them. */
export interface NetworkState {
  /** `navigator.onLine` — whether the browser believes it has connectivity. */
  online: boolean;
  /** Effective connection type (`"slow-2g"`/`"2g"`/`"3g"`/`"4g"`), if known. */
  effectiveType?: string;
  /** Estimated downlink bandwidth in Mb/s, if known. */
  downlink?: number;
  /** Estimated round-trip time in ms, if known. */
  rtt?: number;
  /** Whether the user has requested reduced data usage, if known. */
  saveData?: boolean;
}

/** The Network Information API shape (not in the DOM lib; experimental). */
interface NetworkInformation extends EventTarget {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

const SERVER_STATE: NetworkState = { online: true };

// Referentially-stable snapshot for useSyncExternalStore (see use-window-size).
let cached: NetworkState = SERVER_STATE;

/** `navigator.connection`, if the Network Information API exists here. */
function connectionApi(): NetworkInformation | undefined {
  return typeof navigator !== "undefined"
    ? (navigator as Navigator & { connection?: NetworkInformation }).connection
    : undefined;
}

/** Whether two network snapshots are field-for-field equal. */
function sameState(a: NetworkState, b: NetworkState): boolean {
  return a.online === b.online && a.effectiveType === b.effectiveType &&
    a.downlink === b.downlink && a.rtt === b.rtt && a.saveData === b.saveData;
}

/** The current network state, reusing the cached object when unchanged. */
function currentState(): NetworkState {
  const online = typeof navigator !== "undefined" && typeof navigator.onLine === "boolean"
    ? navigator.onLine
    : true;
  const connection = connectionApi();
  const next: NetworkState = {
    online,
    effectiveType: connection?.effectiveType,
    downlink: connection?.downlink,
    rtt: connection?.rtt,
    saveData: connection?.saveData,
  };
  if (!sameState(next, cached)) cached = next;
  return cached;
}

/**
 * Track online/offline status and connection quality, re-rendering on change.
 *
 * @returns {@linkcode NetworkState}.
 * @example
 * ```tsx
 * "use client";
 * import { useNetworkState } from "denext";
 * const { online, effectiveType } = useNetworkState();
 * return online ? <Sync /> : <OfflineBanner />;
 * ```
 */
export function useNetworkState(): NetworkState {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof globalThis.addEventListener !== "function") return () => {};
    globalThis.addEventListener("online", onChange);
    globalThis.addEventListener("offline", onChange);
    const connection = connectionApi();
    connection?.addEventListener("change", onChange);
    return () => {
      globalThis.removeEventListener("online", onChange);
      globalThis.removeEventListener("offline", onChange);
      connection?.removeEventListener("change", onChange);
    };
  }, []);
  return useSyncExternalStore(subscribe, currentState, () => SERVER_STATE);
}
