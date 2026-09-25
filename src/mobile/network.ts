/**
 * Network reachability for `denext/mobile`: the native `Network` plugin in the shell, else
 * `navigator.onLine` and the `online`/`offline` events.
 *
 * @module
 */

import { useEffect, useState } from "../runtime/hooks.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";

/** The kind of connection a {@linkcode NetworkStatus} reports. */
export type NetworkConnectionType = "wifi" | "cellular" | "none" | "unknown";

/** Whether the device is online, and over what. */
export interface NetworkStatus {
  /** Whether there is a connection (not a guarantee that a given server is reachable). */
  readonly connected: boolean;
  /** `"wifi"` / `"cellular"` when known, `"none"` offline, else `"unknown"`. */
  readonly connectionType: NetworkConnectionType;
}

/** The JS side of `@capacitor/network`. */
interface NetworkPlugin {
  getStatus(): Promise<{ connected?: boolean; connectionType?: string }>;
  addListener(
    eventName: "networkStatusChange",
    listener: (status: { connected?: boolean; connectionType?: string }) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

/** The slice of `navigator` the web path reads. */
interface OnlineNavigator {
  onLine?: boolean;
  connection?: { type?: string };
}

/** The native plugin, when the shell has it. */
function networkPlugin(): NetworkPlugin | undefined {
  return nativePlugin<NetworkPlugin>("Network", ["getStatus", "addListener"]);
}

/** Narrow a connection type string; anything unrecognised is `"unknown"`. */
function connectionType(type: string | undefined): NetworkConnectionType {
  return type === "wifi" || type === "cellular" || type === "none" ? type : "unknown";
}

/** A native status payload as a {@linkcode NetworkStatus}. */
function fromNative(status: { connected?: boolean; connectionType?: string }): NetworkStatus {
  const connected = status.connected !== false;
  return { connected, connectionType: connected ? connectionType(status.connectionType) : "none" };
}

/**
 * The browser's view: `navigator.onLine` (missing counts as online), with the Network
 * Information API's `wifi`/`cellular` where the browser exposes it.
 */
function webStatus(): NetworkStatus {
  const nav = (globalThis as { navigator?: OnlineNavigator }).navigator;
  const connected = nav?.onLine !== false;
  if (!connected) return { connected, connectionType: "none" };
  const type = nav?.connection?.type;
  return { connected, connectionType: type === "wifi" || type === "cellular" ? type : "unknown" };
}

/**
 * Whether the device is online right now, and over what.
 *
 * - Inside the native shell with `@capacitor/network` installed (`denext mobile add
 *   network`), the OS's reachability: `connectionType` is `"wifi"`, `"cellular"`, `"none"` or
 *   `"unknown"`.
 * - Otherwise `navigator.onLine` (only "offline" is reliable there), with `wifi`/`cellular`
 *   from the Network Information API where the browser exposes it. During SSR it reads as
 *   connected, type `"unknown"`.
 *
 * @returns The current status.
 * @example
 * ```ts
 * import { networkStatus } from "denext/mobile";
 *
 * if (!(await networkStatus()).connected) queue.holdUploads();
 * ```
 */
export async function networkStatus(): Promise<NetworkStatus> {
  const plugin = networkPlugin();
  return plugin ? fromNative(await plugin.getStatus()) : webStatus();
}

/**
 * Report the status now and on every change; returns a stop function. Internal (the
 * `denext/expo/network` shim listens through it); not re-exported from `denext/mobile`.
 */
export function watchNetwork(onStatus: (status: NetworkStatus) => void): () => void {
  const plugin = networkPlugin();
  if (plugin) {
    let active = true;
    let changed = false;
    const stop = listenerDisposer(
      plugin.addListener("networkStatusChange", (status) => {
        changed = true;
        if (active) onStatus(fromNative(status));
      }),
    );
    // The first read loses to any change event that beats it.
    plugin.getStatus().then(
      (status) => active && !changed && onStatus(fromNative(status)),
      () => {},
    );
    return () => {
      active = false;
      stop();
    };
  }
  const target = globalThis as Partial<EventTarget>;
  if (typeof target.addEventListener !== "function") return () => {};
  const update = () => onStatus(webStatus());
  target.addEventListener("online", update);
  target.addEventListener("offline", update);
  update();
  return () => {
    target.removeEventListener?.("online", update);
    target.removeEventListener?.("offline", update);
  };
}

/**
 * Hook form of {@linkcode networkStatus}: the current status, updated on every change until
 * unmount. Before mount (and during SSR) it reads `{ connected: true, connectionType:
 * "unknown" }`, so an offline banner never flashes on first paint.
 *
 * @returns The latest network status.
 * @example
 * ```tsx
 * "use client";
 * import { useNetworkStatus } from "denext/mobile";
 *
 * export function OfflineBanner() {
 *   const { connected } = useNetworkStatus();
 *   return connected ? null : <p role="status">You are offline</p>;
 * }
 * ```
 */
export function useNetworkStatus(): NetworkStatus {
  const [status, setStatus] = useState<NetworkStatus>({
    connected: true,
    connectionType: "unknown",
  });
  useEffect(() => watchNetwork(setStatus), []);
  return status;
}
