/**
 * In-app purchases and subscriptions for `denext/mobile`, through RevenueCat's Capacitor SDK
 * (`@revenuecat/purchases-capacitor`, installed by `denext mobile add purchases`), which wraps
 * StoreKit on iOS and Google Play Billing on Android. A RevenueCat project is required (free
 * tier available); verify purchases server-side with `verifyRevenueCatWebhook` from
 * `denext/server`.
 *
 * Store rules: Apple (App Review Guideline 3.1.1) and Google Play (Payments policy) require
 * their in-app purchase for digital goods and features used in the app. There is no web
 * fallback: every call rejects with `unsupported` outside the shell.
 *
 * @module
 */

import { useEffect, useRef, useState } from "../runtime/hooks.ts";
import { nativePlatform } from "./bridge.ts";
import { nativePlugin } from "./plugin.ts";
import { onAppResume } from "./resume.ts";

/** A store product (the fields most apps show; the SDK's full object is passed through). */
export interface PurchaseProduct {
  /** The store's product id. */
  readonly identifier: string;
  /** The localized title. */
  readonly title: string;
  /** The localized description. */
  readonly description: string;
  /** The price in the local currency. */
  readonly price: number;
  /** The formatted price (`"$4.99"`). */
  readonly priceString: string;
  /** The ISO 4217 currency code. */
  readonly currencyCode: string;
  /** Anything else the SDK reports (intro prices, subscription period, …). */
  readonly [key: string]: unknown;
}

/** A package: one product placed in an offering (monthly, annual, lifetime, …). */
export interface PurchasePackage {
  /** The package id (`"$rc_monthly"` for RevenueCat's standard ones). */
  readonly identifier: string;
  /** `"MONTHLY"`, `"ANNUAL"`, `"LIFETIME"`, `"CUSTOM"`, … */
  readonly packageType: string;
  /** The product it sells. */
  readonly product: PurchaseProduct;
  /** The offering it belongs to. */
  readonly offeringIdentifier: string;
  /** Anything else the SDK reports (pass the package back to {@linkcode purchasePackage} as is). */
  readonly [key: string]: unknown;
}

/** An offering: the packages a paywall shows, configured in the RevenueCat dashboard. */
export interface PurchaseOffering {
  /** Its id. */
  readonly identifier: string;
  /** Its description from the dashboard. */
  readonly serverDescription: string;
  /** Its packages. */
  readonly availablePackages: readonly PurchasePackage[];
  /** Metadata from the dashboard. */
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Anything else the SDK reports (`monthly`, `annual`, … shortcuts). */
  readonly [key: string]: unknown;
}

/** Every offering, and the one the dashboard marks current. */
export interface PurchaseOfferings {
  /** The current offering, if any. */
  readonly current: PurchaseOffering | null;
  /** Every offering by id. */
  readonly all: Readonly<Record<string, PurchaseOffering>>;
}

/** One entitlement's state. */
export interface EntitlementInfo {
  /** The entitlement id (as in the dashboard). */
  readonly identifier: string;
  /** Whether it is active now. */
  readonly isActive: boolean;
  /** Whether the subscription renews. */
  readonly willRenew: boolean;
  /** When it expires (ISO 8601), or null for a lifetime purchase. */
  readonly expirationDate: string | null;
  /** The product that grants it. */
  readonly productIdentifier: string;
  /** Anything else the SDK reports. */
  readonly [key: string]: unknown;
}

/** What the user is entitled to (RevenueCat's `CustomerInfo`). */
export interface CustomerInfo {
  /** Entitlements: `active` holds only the active ones. */
  readonly entitlements: {
    readonly all: Readonly<Record<string, EntitlementInfo>>;
    readonly active: Readonly<Record<string, EntitlementInfo>>;
  };
  /** Product ids of the active subscriptions. */
  readonly activeSubscriptions: readonly string[];
  /** RevenueCat's user id (anonymous unless you set `appUserId`). */
  readonly originalAppUserId: string;
  /** Anything else the SDK reports. */
  readonly [key: string]: unknown;
}

/** The result of a completed purchase. */
export interface PurchaseResult {
  /** The product bought. */
  readonly productIdentifier: string;
  /** What the user is entitled to now. */
  readonly customerInfo: CustomerInfo;
  /** The store transaction. */
  readonly transaction: Readonly<Record<string, unknown>>;
}

/** Options for {@linkcode configurePurchases}. */
export interface PurchasesConfig {
  /**
   * The RevenueCat public SDK key: one string, or one per platform (`{ ios: "appl_…", android:
   * "goog_…" }`; RevenueCat issues a key per store).
   */
  readonly apiKey: string | { readonly ios?: string; readonly android?: string };
  /**
   * Your own user id, so purchases follow the account across devices (default: an anonymous
   * RevenueCat id). Never an email or anything guessable.
   */
  readonly appUserId?: string;
}

/** Why a purchases call failed, as {@linkcode PurchasesError}'s `code` reports it. */
export type PurchasesErrorCode =
  /** The user cancelled the purchase sheet. */
  | "cancelled"
  /** Not inside the iOS/Android shell, or the SDK is not installed (there is no web fallback). */
  | "unsupported"
  /** {@linkcode configurePurchases} has not run. */
  | "not_configured"
  /** The store or RevenueCat reported an error (`storeCode` holds its numeric code). */
  | "store";

/** A failed purchases call. */
export interface PurchasesError extends Error {
  /** Why it failed. */
  readonly code: PurchasesErrorCode;
  /** RevenueCat's `PURCHASES_ERROR_CODE` (a numeric string), for `store` errors. */
  readonly storeCode?: string;
}

/** The JS side of `@revenuecat/purchases-capacitor` (its native methods). */
interface PurchasesPlugin {
  configure(configuration: Record<string, unknown>): Promise<void>;
  getOfferings(): Promise<PurchaseOfferings>;
  purchasePackage(options: { aPackage: PurchasePackage }): Promise<PurchaseResult>;
  restorePurchases(): Promise<{ customerInfo: CustomerInfo }>;
  getCustomerInfo(): Promise<{ customerInfo: CustomerInfo }>;
}

/** RevenueCat's `PURCHASE_CANCELLED_ERROR`. */
const CANCELLED = "1";

let configured = false;
const listeners = new Set<(info: CustomerInfo) => void>();

/** Build a {@linkcode PurchasesError}. */
function purchasesError(
  code: PurchasesErrorCode,
  message: string,
  storeCode?: string,
): PurchasesError {
  const err = new Error(message) as Error & { code: PurchasesErrorCode; storeCode?: string };
  err.name = "PurchasesError";
  err.code = code;
  if (storeCode !== undefined) err.storeCode = storeCode;
  return err;
}

/** The SDK, or the `unsupported` error. */
function purchasesPlugin(fn: string): PurchasesPlugin {
  const plugin = nativePlugin<PurchasesPlugin>("Purchases", [
    "configure",
    "getOfferings",
    "purchasePackage",
    "restorePurchases",
    "getCustomerInfo",
  ]);
  if (plugin) return plugin;
  throw purchasesError(
    "unsupported",
    `${fn}: needs the iOS/Android shell with @revenuecat/purchases-capacitor (\`denext mobile ` +
      "add purchases`); in-app purchases have no web fallback.",
  );
}

/** The SDK once configured, or the error. */
function ready(fn: string): PurchasesPlugin {
  const plugin = purchasesPlugin(fn);
  if (!configured) {
    throw purchasesError("not_configured", `${fn}: call configurePurchases({ apiKey }) first.`);
  }
  return plugin;
}

/** A native rejection as a {@linkcode PurchasesError} (the code is on the error or in `data`). */
function fromNative(fn: string, err: unknown): PurchasesError {
  const record = (typeof err === "object" && err !== null ? err : {}) as {
    code?: unknown;
    data?: { code?: unknown };
    message?: unknown;
  };
  const raw = record.code ?? record.data?.code;
  const storeCode = raw === undefined ? undefined : String(raw);
  const message = `${fn}: ${String(record.message ?? err)}`;
  return purchasesError(storeCode === CANCELLED ? "cancelled" : "store", message, storeCode);
}

/** Tell every {@linkcode useEntitlement} about fresh customer info. */
function publish(info: CustomerInfo): CustomerInfo {
  for (const listener of [...listeners]) listener(info);
  return info;
}

/** The key for this platform. */
function keyFor(apiKey: PurchasesConfig["apiKey"]): string | undefined {
  if (typeof apiKey === "string") return apiKey;
  const platform = nativePlatform();
  return platform === "web" ? undefined : apiKey?.[platform];
}

/**
 * Configure RevenueCat once, early (a root layout's effect), before any other purchases call.
 *
 * @param config The public SDK key(s) and, optionally, your user id.
 * @returns A promise that settles once configured.
 * @example
 * ```ts
 * import { configurePurchases } from "denext/mobile";
 *
 * await configurePurchases({ apiKey: { ios: "appl_…", android: "goog_…" }, appUserId: user.id });
 * ```
 */
export async function configurePurchases(config: PurchasesConfig): Promise<void> {
  const fn = "configurePurchases";
  const plugin = purchasesPlugin(fn);
  const apiKey = keyFor(config?.apiKey);
  if (!apiKey) throw new TypeError(`${fn}: no RevenueCat API key for ${nativePlatform()}`);
  try {
    await plugin.configure({ apiKey, appUserID: config.appUserId ?? null });
  } catch (err) {
    throw fromNative(fn, err);
  }
  configured = true;
}

/**
 * The offerings configured in the RevenueCat dashboard, with the store's localized prices.
 *
 * @returns Every offering, and the current one.
 * @example
 * ```ts
 * import { getOfferings } from "denext/mobile";
 *
 * const { current } = await getOfferings();
 * for (const pkg of current?.availablePackages ?? []) show(pkg.product.title, pkg.product.priceString);
 * ```
 */
export async function getOfferings(): Promise<PurchaseOfferings> {
  const fn = "getOfferings";
  const plugin = ready(fn);
  try {
    return await plugin.getOfferings();
  } catch (err) {
    throw fromNative(fn, err);
  }
}

/**
 * Buy a package through the store's purchase sheet. It resolves once the store completed the
 * purchase (and RevenueCat recorded it), and rejects with a {@linkcode PurchasesError}:
 * `cancelled` when the user closed the sheet, `store` for anything the store refused.
 *
 * @param pkg A package from {@linkcode getOfferings}, as it came.
 * @returns The product, the transaction and the updated customer info.
 * @example
 * ```ts
 * import { purchasePackage } from "denext/mobile";
 *
 * try {
 *   const { customerInfo } = await purchasePackage(pkg);
 *   if (customerInfo.entitlements.active.pro) unlockPro();
 * } catch (err) {
 *   if ((err as { code?: string }).code !== "cancelled") showError(err);
 * }
 * ```
 */
export async function purchasePackage(pkg: PurchasePackage): Promise<PurchaseResult> {
  const fn = "purchasePackage";
  const plugin = ready(fn);
  let result: PurchaseResult;
  try {
    result = await plugin.purchasePackage({ aPackage: pkg });
  } catch (err) {
    throw fromNative(fn, err);
  }
  publish(result.customerInfo);
  return result;
}

/**
 * Restore the user's earlier purchases (the "Restore purchases" button App Review expects on a
 * paywall).
 *
 * @returns The customer info after restoring.
 */
export async function restorePurchases(): Promise<CustomerInfo> {
  const fn = "restorePurchases";
  const plugin = ready(fn);
  try {
    return publish((await plugin.restorePurchases()).customerInfo);
  } catch (err) {
    throw fromNative(fn, err);
  }
}

/**
 * What the user is entitled to now (RevenueCat caches it; it refreshes in the background).
 *
 * @returns The customer info.
 */
export async function getCustomerInfo(): Promise<CustomerInfo> {
  const fn = "getCustomerInfo";
  const plugin = ready(fn);
  try {
    return publish((await plugin.getCustomerInfo()).customerInfo);
  } catch (err) {
    throw fromNative(fn, err);
  }
}

/** What {@linkcode useEntitlement} returns. */
export interface EntitlementState {
  /** Whether the entitlement is active (`undefined` until the first answer). */
  readonly active: boolean | undefined;
  /** The entitlement's details, when the user has (or had) it. */
  readonly entitlement: EntitlementInfo | undefined;
  /** The last error (e.g. `unsupported` on the web, `not_configured`). */
  readonly error: PurchasesError | undefined;
  /** Ask RevenueCat again. */
  readonly refresh: () => Promise<void>;
}

/**
 * Whether the user has an entitlement, live: read on mount, after every purchase / restore /
 * `getCustomerInfo` anywhere in the app, and each time the app returns to the foreground.
 *
 * @param id The entitlement id from the RevenueCat dashboard.
 * @returns Whether it is active, its details, and the last error.
 * @example
 * ```tsx
 * "use client";
 * import { useEntitlement } from "denext/mobile";
 *
 * export function ProBadge() {
 *   const { active } = useEntitlement("pro");
 *   return active ? <span>PRO</span> : null;
 * }
 * ```
 */
export function useEntitlement(id: string): EntitlementState {
  const [state, setState] = useState<{ info?: CustomerInfo; error?: PurchasesError }>({});
  const refresh = useRef(async () => {
    try {
      await getCustomerInfo();
    } catch (err) {
      setState((prev) => ({ info: prev.info, error: err as PurchasesError }));
    }
  });
  useEffect(() => {
    const listener = (info: CustomerInfo) => setState({ info });
    listeners.add(listener);
    refresh.current();
    const stop = onAppResume(() => void refresh.current());
    return () => {
      listeners.delete(listener);
      stop();
    };
  }, []);
  const entitlement = state.info?.entitlements?.all?.[id];
  return {
    active: state.info ? state.info.entitlements?.active?.[id]?.isActive === true : undefined,
    entitlement,
    error: state.error,
    refresh: () => refresh.current(),
  };
}

/** Forget the configuration and listeners (tests only). */
export function resetPurchasesForTesting(): void {
  configured = false;
  listeners.clear();
}
