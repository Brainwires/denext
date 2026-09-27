/**
 * `@react-native-community/netinfo` for denext's React Native mode: `fetch`, `refresh`,
 * `addEventListener`, `useNetInfo` and `useNetInfoInstance` over `denext/mobile`'s
 * {@linkcode networkStatus} / {@linkcode watchNetwork} (`@capacitor/network` in the Capacitor
 * shell, `denext mobile add network`; `navigator.onLine` and the Network Information API on
 * the web).
 *
 * The state has the package's shape. `type` is `wifi`, `cellular`, `none` or `unknown` (the
 * plugin reports nothing finer); a connected `wifi` / `cellular` state carries the package's
 * `details` keys, all `null` (no SSID, carrier or generation) except `isConnectionExpensive`
 * (true on cellular). `isInternetReachable` follows `isConnected`: no reachability probe runs,
 * so `configure()` is accepted and ignored.
 *
 * In React Native mode `import NetInfo from "@react-native-community/netinfo"` resolves here.
 *
 * @example
 * ```ts
 * import NetInfo from "@react-native-community/netinfo";
 *
 * const state = await NetInfo.fetch();
 * const unsubscribe = NetInfo.addEventListener((s) => console.log(s.type, s.isConnected));
 * ```
 *
 * @module
 */

import { useCallback, useEffect, useState } from "../runtime/hooks.ts";
import { type NetworkStatus, networkStatus, watchNetwork } from "../mobile/network.ts";

/** The connection types the package reports. */
export enum NetInfoStateType {
  /** Not known yet. */
  unknown = "unknown",
  /** No connection. */
  none = "none",
  /** A cellular connection. */
  cellular = "cellular",
  /** Wi-Fi. */
  wifi = "wifi",
  /** Bluetooth (never reported here). */
  bluetooth = "bluetooth",
  /** Ethernet (never reported here). */
  ethernet = "ethernet",
  /** WiMAX (never reported here). */
  wimax = "wimax",
  /** A VPN (never reported here). */
  vpn = "vpn",
  /** Something else (never reported here). */
  other = "other",
}

/** Cellular generations (never reported here: `cellularGeneration` is `null`). */
export enum NetInfoCellularGeneration {
  /** 2G. */
  "2g" = "2g",
  /** 3G. */
  "3g" = "3g",
  /** 4G. */
  "4g" = "4g",
  /** 5G. */
  "5g" = "5g",
}

/** The network state, as the package reports it. */
export interface NetInfoState {
  /** The connection type. */
  type: NetInfoStateType;
  /** Whether there is a connection (`null` before the first read). */
  isConnected: boolean | null;
  /** Whether the internet is reachable: `isConnected` here (`null` while unknown). */
  isInternetReachable: boolean | null;
  /** Whether Wi-Fi is on (Android only in the package; never set here). */
  isWifiEnabled?: boolean;
  /** Type-specific details, or `null` when disconnected or unknown. */
  details: Record<string, unknown> | null;
}

/** A state listener. */
export type NetInfoChangeHandler = (state: NetInfoState) => void;

/** Unsubscribes an {@linkcode addEventListener} listener. */
export type NetInfoSubscription = () => void;

/** The package's configuration (accepted and ignored: no reachability probe runs). */
export interface NetInfoConfiguration {
  /** The URL probed for reachability. */
  reachabilityUrl: string;
  /** The probe's method. */
  reachabilityMethod?: "HEAD" | "GET";
  /** The probe's headers. */
  reachabilityHeaders?: Record<string, string>;
  /** Whether a probe response means reachable. */
  reachabilityTest: (response: Response) => Promise<boolean>;
  /** Probe interval while reachable. */
  reachabilityLongTimeout: number;
  /** Probe interval while unreachable. */
  reachabilityShortTimeout: number;
  /** The probe's timeout. */
  reachabilityRequestTimeout: number;
  /** Whether to probe at all. */
  reachabilityShouldRun: () => boolean;
  /** Android / iOS: read the Wi-Fi SSID. */
  shouldFetchWiFiSSID: boolean;
  /** Use the platform's own reachability. */
  useNativeReachability: boolean;
}

/** The state before anything is known (the package's initial state). */
const UNKNOWN: NetInfoState = {
  type: NetInfoStateType.unknown,
  isConnected: null,
  isInternetReachable: null,
  details: null,
};

/** The `details` of a connected state of `type`. */
function detailsOf(type: NetInfoStateType): Record<string, unknown> {
  const base = { isConnectionExpensive: type === NetInfoStateType.cellular };
  if (type === NetInfoStateType.cellular) {
    return { ...base, cellularGeneration: null, carrier: null };
  }
  if (type === NetInfoStateType.wifi) {
    return {
      ...base,
      ssid: null,
      bssid: null,
      strength: null,
      ipAddress: null,
      subnet: null,
      frequency: null,
      linkSpeed: null,
      rxLinkSpeed: null,
      txLinkSpeed: null,
    };
  }
  return base;
}

/**
 * A denext {@linkcode NetworkStatus} as the package's state.
 *
 * @param status The status.
 * @returns The state.
 */
function toNetInfoState(status: NetworkStatus): NetInfoState {
  if (!status.connected) {
    return {
      type: NetInfoStateType.none,
      isConnected: false,
      isInternetReachable: false,
      details: null,
    };
  }
  const type = status.connectionType === "wifi"
    ? NetInfoStateType.wifi
    : status.connectionType === "cellular"
    ? NetInfoStateType.cellular
    : NetInfoStateType.unknown;
  return {
    type,
    isConnected: true,
    isInternetReachable: true,
    details: type === NetInfoStateType.unknown ? null : detailsOf(type),
  };
}

/**
 * Accept the package's configuration. Nothing here uses it: there is no reachability probe.
 *
 * @param _configuration The configuration (ignored).
 */
export function configure(_configuration: Partial<NetInfoConfiguration>): void {}

/**
 * Read the network state once.
 *
 * @param _requestedInterface The interface to read (ignored: the current connection).
 * @returns The state.
 */
export async function fetch(_requestedInterface?: string): Promise<NetInfoState> {
  return toNetInfoState(await networkStatus());
}

/**
 * Read the network state again (the same as {@linkcode fetch} here).
 *
 * @returns The state.
 */
export function refresh(): Promise<NetInfoState> {
  return fetch();
}

/**
 * Call `listener` with the current state, then on every change.
 *
 * @param listener Called with each state.
 * @returns A function that unsubscribes.
 */
export function addEventListener(listener: NetInfoChangeHandler): NetInfoSubscription {
  return watchNetwork((status) => listener(toNetInfoState(status)));
}

/**
 * The network state, kept current (the package's initial `unknown` state until the first read).
 *
 * @param _configuration The configuration (ignored).
 * @returns The state.
 */
export function useNetInfo(_configuration?: Partial<NetInfoConfiguration>): NetInfoState {
  return useNetInfoInstance(false).netInfo;
}

/**
 * The network state and a `refresh`, kept current while `isPaused` is not true.
 *
 * @param isPaused Stop listening while true.
 * @param _configuration The configuration (ignored).
 * @returns The state and a function that reads it again.
 */
export function useNetInfoInstance(
  isPaused = false,
  _configuration?: Partial<NetInfoConfiguration>,
): { netInfo: NetInfoState; refresh: () => void } {
  const [netInfo, setNetInfo] = useState<NetInfoState>(UNKNOWN);
  useEffect(() => {
    if (isPaused) return;
    return addEventListener(setNetInfo);
  }, [isPaused]);
  const again = useCallback(() => {
    fetch().then(setNetInfo, () => {});
  }, []);
  return { netInfo, refresh: again };
}

/** The package's default export. */
const NetInfo: {
  configure: typeof configure;
  fetch: typeof fetch;
  refresh: typeof refresh;
  addEventListener: typeof addEventListener;
  useNetInfo: typeof useNetInfo;
  useNetInfoInstance: typeof useNetInfoInstance;
} = { configure, fetch, refresh, addEventListener, useNetInfo, useNetInfoInstance };

export default NetInfo;
