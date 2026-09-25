/**
 * `expo-network` for denext: network state over `denext/mobile`'s network status
 * (`@capacitor/network` in the Capacitor shell, `navigator.onLine` plus the Network
 * Information API on the web).
 *
 * @example
 * ```ts
 * import * as Network from "denext/expo/network";
 *
 * const { isConnected } = await Network.getNetworkStateAsync();
 * const sub = Network.addNetworkStateListener((state) => console.log(state.type));
 * ```
 *
 * @module
 */

import { useEffect, useState } from "../runtime/hooks.ts";
import { type NetworkStatus, networkStatus, watchNetwork } from "../mobile/network.ts";
import { type Subscription, subscription } from "./internal/common.ts";

export type { Subscription };

/** The kind of connection. */
export enum NetworkStateType {
  /** No connection. */
  NONE = "NONE",
  /** Unknown. */
  UNKNOWN = "UNKNOWN",
  /** Cellular data. */
  CELLULAR = "CELLULAR",
  /** Wi-Fi. */
  WIFI = "WIFI",
  /** Bluetooth. */
  BLUETOOTH = "BLUETOOTH",
  /** Ethernet. */
  ETHERNET = "ETHERNET",
  /** WiMAX. */
  WIMAX = "WIMAX",
  /** A VPN. */
  VPN = "VPN",
  /** Something else. */
  OTHER = "OTHER",
}

/** The device's network state. */
export interface NetworkState {
  /** The connection kind. */
  type?: NetworkStateType;
  /** Whether there is a connection. */
  isConnected?: boolean;
  /** Whether the internet is reachable (the same as `isConnected` here). */
  isInternetReachable?: boolean;
}

/** What a network listener receives. */
export type NetworkStateEvent = NetworkState;

/** denext's connection types → Expo's. */
const TYPES: Readonly<Record<string, NetworkStateType>> = {
  wifi: NetworkStateType.WIFI,
  cellular: NetworkStateType.CELLULAR,
  none: NetworkStateType.NONE,
  unknown: NetworkStateType.UNKNOWN,
};

/** A `denext/mobile` status as an Expo network state. */
function toState(status: NetworkStatus): NetworkState {
  return {
    type: TYPES[status.connectionType] ?? NetworkStateType.UNKNOWN,
    isConnected: status.connected,
    isInternetReachable: status.connected,
  };
}

/**
 * The current network state.
 *
 * @returns The state.
 */
export async function getNetworkStateAsync(): Promise<NetworkState> {
  return toState(await networkStatus());
}

/**
 * The device's IP address: not available to a web page, so `"0.0.0.0"` (Expo's web value).
 *
 * @returns `"0.0.0.0"`.
 */
export function getIpAddressAsync(): Promise<string> {
  return Promise.resolve("0.0.0.0");
}

/**
 * Whether airplane mode is on: not observable here, so `false`.
 *
 * @returns `false`.
 */
export function isAirplaneModeEnabledAsync(): Promise<boolean> {
  return Promise.resolve(false);
}

/**
 * Call `listener` with the state now and on every change.
 *
 * @param listener Called with each state.
 * @returns A subscription to remove.
 */
export function addNetworkStateListener(
  listener: (event: NetworkStateEvent) => void,
): Subscription {
  return subscription(watchNetwork((status) => listener(toState(status))));
}

/**
 * Hook form: the current state, updated on every change. Before the first report it reads
 * `{ type: UNKNOWN }`.
 *
 * @returns The latest state.
 */
export function useNetworkState(): NetworkState {
  const [state, setState] = useState<NetworkState>({ type: NetworkStateType.UNKNOWN });
  useEffect(() => watchNetwork((status) => setState(toState(status))), []);
  return state;
}
