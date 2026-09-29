/**
 * `react-native-purchases` (RevenueCat) for denext's React Native mode: the `Purchases` class
 * over `denext/mobile`'s purchases ({@linkcode configurePurchases}, {@linkcode getOfferings},
 * {@linkcode purchasePackage}, {@linkcode restorePurchases}, {@linkcode getCustomerInfo}),
 * which drive `@revenuecat/purchases-capacitor` in the Capacitor shell
 * (`denext mobile add purchases`): StoreKit on iOS, Google Play Billing on Android. There is no
 * web fallback (the package's own browser mode is RevenueCat Web Billing, which a store app
 * must not use): outside the shell every call rejects with `UnsupportedPlatformError`.
 *
 * `configure` starts configuring and returns at once, as the package's does; every other call
 * waits for it. The account calls (`logIn`, `logOut`, `getAppUserID`, `isAnonymous`), the
 * subscriber attributes (`setAttributes`, `setEmail`, …), `getProducts`,
 * `purchaseStoreProduct`, `syncPurchases`, `invalidateCustomerInfoCache`, `setLogLevel`,
 * `canMakePayments` and `showManageSubscriptions` go to the same Capacitor plugin directly. The
 * results are RevenueCat's own shapes (the plugin is the same hybrid SDK). A failed call
 * rejects with an error whose `code` is a {@linkcode PURCHASES_ERROR_CODE} and whose
 * `userCancelled` is set for a cancelled purchase. The ad tracking, win-back, promotional
 * offer, Amazon, refund and web-redemption APIs are not provided.
 *
 * @example
 * ```ts
 * import Purchases from "react-native-purchases";
 *
 * Purchases.configure({ apiKey: Platform.OS === "ios" ? APPLE_KEY : GOOGLE_KEY });
 * const offerings = await Purchases.getOfferings();
 * const pkg = offerings.current?.availablePackages[0];
 * if (pkg) await Purchases.purchasePackage(pkg);
 * ```
 *
 * @module
 */

import {
  configurePurchases,
  type CustomerInfo,
  type EntitlementInfo,
  getCustomerInfo,
  getOfferings,
  type PurchaseOffering,
  type PurchaseOfferings,
  type PurchasePackage,
  purchasePackage,
  type PurchaseProduct,
  type PurchaseResult,
  restorePurchases,
} from "../mobile/purchases.ts";
import { isNativeShell } from "../mobile/bridge.ts";

export type {
  CustomerInfo,
  EntitlementInfo,
  PurchaseOffering,
  PurchaseOfferings,
  PurchasePackage,
  PurchaseProduct,
  PurchaseResult,
};

/** RevenueCat's error codes (`error.code`). */
export enum PURCHASES_ERROR_CODE {
  /** Unknown. */
  UNKNOWN_ERROR = "0",
  /** The user cancelled. */
  PURCHASE_CANCELLED_ERROR = "1",
  /** The store reported a problem. */
  STORE_PROBLEM_ERROR = "2",
  /** Purchases are not allowed on this device. */
  PURCHASE_NOT_ALLOWED_ERROR = "3",
  /** The purchase was invalid. */
  PURCHASE_INVALID_ERROR = "4",
  /** The product is not for sale. */
  PRODUCT_NOT_AVAILABLE_FOR_PURCHASE_ERROR = "5",
  /** Already purchased. */
  PRODUCT_ALREADY_PURCHASED_ERROR = "6",
  /** The receipt is in use by another subscriber. */
  RECEIPT_ALREADY_IN_USE_ERROR = "7",
  /** The receipt is invalid. */
  INVALID_RECEIPT_ERROR = "8",
  /** The receipt file is missing. */
  MISSING_RECEIPT_FILE_ERROR = "9",
  /** A network error. */
  NETWORK_ERROR = "10",
  /** The API key is invalid. */
  INVALID_CREDENTIALS_ERROR = "11",
  /** The backend answered unexpectedly. */
  UNEXPECTED_BACKEND_RESPONSE_ERROR = "12",
  /** The receipt belongs to another subscriber. */
  RECEIPT_IN_USE_BY_OTHER_SUBSCRIBER_ERROR = "13",
  /** The app user id is invalid. */
  INVALID_APP_USER_ID_ERROR = "14",
  /** An operation is already in progress. */
  OPERATION_ALREADY_IN_PROGRESS_ERROR = "15",
  /** An unknown backend error. */
  UNKNOWN_BACKEND_ERROR = "16",
  /** The Apple subscription key is invalid. */
  INVALID_APPLE_SUBSCRIPTION_KEY_ERROR = "17",
  /** Not eligible. */
  INELIGIBLE_ERROR = "18",
  /** Insufficient permissions. */
  INSUFFICIENT_PERMISSIONS_ERROR = "19",
  /** The payment is pending. */
  PAYMENT_PENDING_ERROR = "20",
  /** The subscriber attributes are invalid. */
  INVALID_SUBSCRIBER_ATTRIBUTES_ERROR = "21",
  /** An anonymous user cannot log out. */
  LOG_OUT_ANONYMOUS_USER_ERROR = "22",
  /** A configuration error. */
  CONFIGURATION_ERROR = "23",
  /** Not supported here. */
  UNSUPPORTED_ERROR = "24",
  /** No subscriber attributes. */
  EMPTY_SUBSCRIBER_ATTRIBUTES_ERROR = "25",
  /** A discount is missing its identifier. */
  PRODUCT_DISCOUNT_MISSING_IDENTIFIER_ERROR = "26",
  /** A discount is missing its subscription group. */
  PRODUCT_DISCOUNT_MISSING_SUBSCRIPTION_GROUP_IDENTIFIER_ERROR = "28",
  /** The customer info could not be read. */
  CUSTOMER_INFO_ERROR = "29",
  /** The system info could not be read. */
  SYSTEM_INFO_ERROR = "30",
  /** A refund request failed. */
  BEGIN_REFUND_REQUEST_ERROR = "31",
  /** The product request timed out. */
  PRODUCT_REQUEST_TIMED_OUT_ERROR = "32",
  /** The API endpoint is blocked. */
  API_ENDPOINT_BLOCKED = "33",
  /** The promotional offer is invalid. */
  INVALID_PROMOTIONAL_OFFER_ERROR = "34",
  /** Offline. */
  OFFLINE_CONNECTION_ERROR = "35",
  /** A simulated Test Store purchase error. */
  TEST_STORE_SIMULATED_PURCHASE_ERROR = "42",
}

/** A package's duration. */
export enum PACKAGE_TYPE {
  /** Unknown. */
  UNKNOWN = "UNKNOWN",
  /** Custom. */
  CUSTOM = "CUSTOM",
  /** Lifetime. */
  LIFETIME = "LIFETIME",
  /** Annual. */
  ANNUAL = "ANNUAL",
  /** Six months. */
  SIX_MONTH = "SIX_MONTH",
  /** Three months. */
  THREE_MONTH = "THREE_MONTH",
  /** Two months. */
  TWO_MONTH = "TWO_MONTH",
  /** Monthly. */
  MONTHLY = "MONTHLY",
  /** Weekly. */
  WEEKLY = "WEEKLY",
}

/** Introductory-offer eligibility. */
export enum INTRO_ELIGIBILITY_STATUS {
  /** Unknown. */
  INTRO_ELIGIBILITY_STATUS_UNKNOWN = 0,
  /** Not eligible. */
  INTRO_ELIGIBILITY_STATUS_INELIGIBLE = 1,
  /** Eligible. */
  INTRO_ELIGIBILITY_STATUS_ELIGIBLE = 2,
  /** The product has no introductory offer. */
  INTRO_ELIGIBILITY_STATUS_NO_INTRO_OFFER_EXISTS = 3,
}

/** A product's category. */
export enum PRODUCT_CATEGORY {
  /** A one-time purchase. */
  NON_SUBSCRIPTION = "NON_SUBSCRIPTION",
  /** A subscription. */
  SUBSCRIPTION = "SUBSCRIPTION",
  /** Unknown. */
  UNKNOWN = "UNKNOWN",
}

/** A product's type. */
export enum PRODUCT_TYPE {
  /** Consumable. */
  CONSUMABLE = "CONSUMABLE",
  /** Non-consumable. */
  NON_CONSUMABLE = "NON_CONSUMABLE",
  /** A non-renewing subscription. */
  NON_RENEWABLE_SUBSCRIPTION = "NON_RENEWABLE_SUBSCRIPTION",
  /** An auto-renewing subscription. */
  AUTO_RENEWABLE_SUBSCRIPTION = "AUTO_RENEWABLE_SUBSCRIPTION",
  /** A prepaid subscription. */
  PREPAID_SUBSCRIPTION = "PREPAID_SUBSCRIPTION",
  /** Unknown. */
  UNKNOWN = "UNKNOWN",
}

/** Google Play's legacy proration modes. */
export enum PRORATION_MODE {
  /** Unknown. */
  UNKNOWN_SUBSCRIPTION_UPGRADE_DOWNGRADE_POLICY = 0,
  /** Immediately, with time proration. */
  IMMEDIATE_WITH_TIME_PRORATION = 1,
  /** Immediately, charging the prorated price. */
  IMMEDIATE_AND_CHARGE_PRORATED_PRICE = 2,
  /** Immediately, without proration. */
  IMMEDIATE_WITHOUT_PRORATION = 3,
  /** Immediately, charging the full price. */
  IMMEDIATE_AND_CHARGE_FULL_PRICE = 5,
  /** At the next renewal. */
  DEFERRED = 6,
}

/** Google Play's replacement modes. */
export enum STORE_REPLACEMENT_MODE {
  /** Without proration. */
  WITHOUT_PRORATION = "WITHOUT_PRORATION",
  /** With time proration. */
  WITH_TIME_PRORATION = "WITH_TIME_PRORATION",
  /** Charging the full price. */
  CHARGE_FULL_PRICE = "CHARGE_FULL_PRICE",
  /** Charging the prorated price. */
  CHARGE_PRORATED_PRICE = "CHARGE_PRORATED_PRICE",
  /** At the next renewal. */
  DEFERRED = "DEFERRED",
}

/** A pricing phase's recurrence. */
export enum RECURRENCE_MODE {
  /** Recurs forever. */
  INFINITE_RECURRING = 1,
  /** Recurs a set number of times. */
  FINITE_RECURRING = 2,
  /** Does not recur. */
  NON_RECURRING = 3,
}

/** An offer's payment mode. */
export enum OFFER_PAYMENT_MODE {
  /** A free trial. */
  FREE_TRIAL = "FREE_TRIAL",
  /** One payment. */
  SINGLE_PAYMENT = "SINGLE_PAYMENT",
  /** A discounted recurring payment. */
  DISCOUNTED_RECURRING_PAYMENT = "DISCOUNTED_RECURRING_PAYMENT",
}

/** A period's unit. */
export enum PERIOD_UNIT {
  /** Days. */
  DAY = "DAY",
  /** Weeks. */
  WEEK = "WEEK",
  /** Months. */
  MONTH = "MONTH",
  /** Years. */
  YEAR = "YEAR",
  /** Unknown. */
  UNKNOWN = "UNKNOWN",
}

/** Google Play's legacy purchase types. */
export enum PURCHASE_TYPE {
  /** A one-time product. */
  INAPP = "inapp",
  /** A subscription. */
  SUBS = "subs",
}

/** Google Play billing features. */
export enum BILLING_FEATURE {
  /** Subscriptions. */
  SUBSCRIPTIONS = 0,
  /** Subscription updates. */
  SUBSCRIPTIONS_UPDATE = 1,
  /** In-app items on VR. */
  IN_APP_ITEMS_ON_VR = 2,
  /** Subscriptions on VR. */
  SUBSCRIPTIONS_ON_VR = 3,
  /** Price change confirmation. */
  PRICE_CHANGE_CONFIRMATION = 4,
}

/** A refund request's outcome. */
export enum REFUND_REQUEST_STATUS {
  /** Requested. */
  SUCCESS = 0,
  /** The user cancelled. */
  USER_CANCELLED = 1,
  /** Failed. */
  ERROR = 2,
}

/** The SDK's log levels. */
export enum LOG_LEVEL {
  /** Everything. */
  VERBOSE = "VERBOSE",
  /** Debug. */
  DEBUG = "DEBUG",
  /** Info. */
  INFO = "INFO",
  /** Warnings. */
  WARN = "WARN",
  /** Errors only. */
  ERROR = "ERROR",
}

/** In-app message types. */
export enum IN_APP_MESSAGE_TYPE {
  /** A billing issue. */
  BILLING_ISSUE = 0,
  /** A price increase consent. */
  PRICE_INCREASE_CONSENT = 1,
  /** A generic message. */
  GENERIC = 2,
  /** A win-back offer. */
  WIN_BACK_OFFER = 3,
}

/** Entitlement verification modes. */
export enum ENTITLEMENT_VERIFICATION_MODE {
  /** Off. */
  DISABLED = "DISABLED",
  /** Informational. */
  INFORMATIONAL = "INFORMATIONAL",
}

/** Entitlement verification results. */
export enum VERIFICATION_RESULT {
  /** Not requested. */
  NOT_REQUESTED = "NOT_REQUESTED",
  /** Verified. */
  VERIFIED = "VERIFIED",
  /** Failed. */
  FAILED = "FAILED",
  /** Verified on the device. */
  VERIFIED_ON_DEVICE = "VERIFIED_ON_DEVICE",
}

/** The StoreKit version to use. */
export enum STOREKIT_VERSION {
  /** StoreKit 1. */
  STOREKIT_1 = "STOREKIT_1",
  /** StoreKit 2. */
  STOREKIT_2 = "STOREKIT_2",
  /** The SDK's default. */
  DEFAULT = "DEFAULT",
}

/** Who finishes transactions. */
export enum PURCHASES_ARE_COMPLETED_BY_TYPE {
  /** The app. */
  MY_APP = "MY_APP",
  /** RevenueCat. */
  REVENUECAT = "REVENUECAT",
}

/** A web purchase redemption's outcome. */
export enum WebPurchaseRedemptionResultType {
  /** Redeemed. */
  SUCCESS = "SUCCESS",
  /** Failed. */
  ERROR = "ERROR",
  /** Belongs to another user. */
  PURCHASE_BELONGS_TO_OTHER_USER = "PURCHASE_BELONGS_TO_OTHER_USER",
  /** The token is invalid. */
  INVALID_TOKEN = "INVALID_TOKEN",
  /** The token expired. */
  EXPIRED = "EXPIRED",
}

/** Ad mediator names (for the ad tracker, which is not provided). */
export const AdMediatorName: { readonly adMob: "AdMob"; readonly appLovin: "AppLovin" } = {
  adMob: "AdMob",
  appLovin: "AppLovin",
};

/** Ad formats (for the ad tracker, which is not provided). */
export const AdFormat: {
  /** Other. */
  readonly other: "other";
  /** A banner. */
  readonly banner: "banner";
  /** An interstitial. */
  readonly interstitial: "interstitial";
  /** A rewarded ad. */
  readonly rewarded: "rewarded";
  /** A rewarded interstitial. */
  readonly rewardedInterstitial: "rewarded_interstitial";
  /** A native ad. */
  readonly nativeAd: "native";
  /** An app-open ad. */
  readonly appOpen: "app_open";
} = {
  other: "other",
  banner: "banner",
  interstitial: "interstitial",
  rewarded: "rewarded",
  rewardedInterstitial: "rewarded_interstitial",
  nativeAd: "native",
  appOpen: "app_open",
};

/** Ad revenue precisions (for the ad tracker, which is not provided). */
export const AdRevenuePrecision: {
  /** Exact. */
  readonly exact: "exact";
  /** Publisher-defined. */
  readonly publisherDefined: "publisher_defined";
  /** Estimated. */
  readonly estimated: "estimated";
  /** Unknown. */
  readonly unknown: "unknown";
} = {
  exact: "exact",
  publisherDefined: "publisher_defined",
  estimated: "estimated",
  unknown: "unknown",
};

/** Thrown by a call made before {@linkcode Purchases}`.configure`. */
export class UninitializedPurchasesError extends Error {
  constructor() {
    super(
      "There is no singleton instance. Make sure you configure Purchases before trying to get " +
        "the default instance. More info here: https://errors.rev.cat/configuring-sdk",
    );
  }
}

/** Thrown by a call that is not available here (outside the shell, or not provided). */
export class UnsupportedPlatformError extends Error {
  constructor() {
    super("This method is not available in the current platform.");
  }
}

/** Options for {@linkcode Purchases}`.configure`. */
export type PurchasesConfiguration = {
  /** This platform's public SDK key. */
  apiKey: string;
  /** Your user id (default: an anonymous id). */
  appUserID?: string | null;
  /** Any other option (passed through to the plugin's configure, where it applies). */
  [option: string]: unknown;
};

/** A customer info listener. */
export type CustomerInfoUpdateListener = (customerInfo: CustomerInfo) => void;

/** A log handler (not called: the plugin logs natively). */
export type LogHandler = (logLevel: LOG_LEVEL, message: string) => void;

/** What {@linkcode Purchases}`.logIn` resolves to. */
export interface LogInResult {
  /** The customer info. */
  readonly customerInfo: CustomerInfo;
  /** Whether a new RevenueCat user was created. */
  readonly created: boolean;
}

/** What a purchase resolves to. */
export type MakePurchaseResult = PurchaseResult;

/** An error a call rejects with. */
export interface PurchasesError extends Error {
  /** A {@linkcode PURCHASES_ERROR_CODE} value. */
  code: string;
  /** Whether the user cancelled the purchase. */
  userCancelled: boolean | null;
}

/** The plugin's raw methods, called directly for what denext/mobile does not cover. */
type RawPlugin = Record<string, ((options?: unknown) => Promise<unknown>) | undefined>;

let ready: Promise<void> | null = null;
const listeners = new Set<CustomerInfoUpdateListener>();

/** A {@linkcode PurchasesError}. */
function purchasesError(code: string, message: string, userCancelled = false): PurchasesError {
  return Object.assign(new Error(message), { code, userCancelled });
}

/** denext's purchases error as the package's. */
function translate(err: unknown): unknown {
  const e = err as { code?: string; storeCode?: string; message?: string };
  switch (e?.code) {
    case "unsupported":
      return new UnsupportedPlatformError();
    case "not_configured":
      return new UninitializedPurchasesError();
    case "cancelled":
      return purchasesError(PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR, String(e.message), true);
    case "store":
      return purchasesError(e.storeCode ?? PURCHASES_ERROR_CODE.UNKNOWN_ERROR, String(e.message));
    default:
      return err;
  }
}

/** Wait for configure, run `fn`, and translate its errors. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  if (!ready) throw new UninitializedPurchasesError();
  try {
    await ready;
    return await fn();
  } catch (err) {
    throw translate(err);
  }
}

/** Call the plugin's `method` directly (after configure). */
function raw<T>(method: string, options?: unknown): Promise<T> {
  return call(async () => {
    const plugin = isNativeShell()
      ? (globalThis as { Capacitor?: { Plugins?: Record<string, RawPlugin> } }).Capacitor
        ?.Plugins?.Purchases
      : undefined;
    const fn = plugin?.[method];
    if (typeof fn !== "function") throw new UnsupportedPlatformError();
    return await fn.call(plugin, options) as T;
  });
}

/** Tell every listener about fresh customer info. */
function publish(info: CustomerInfo): CustomerInfo {
  for (const listener of [...listeners]) listener(info);
  return info;
}

/**
 * RevenueCat's `Purchases` class: static methods only, as in the package.
 */
export default class Purchases {
  /** {@linkcode PURCHASE_TYPE}. */
  static PURCHASE_TYPE: typeof PURCHASE_TYPE = PURCHASE_TYPE;
  /** {@linkcode PRODUCT_CATEGORY}. */
  static PRODUCT_CATEGORY: typeof PRODUCT_CATEGORY = PRODUCT_CATEGORY;
  /** {@linkcode BILLING_FEATURE}. */
  static BILLING_FEATURE: typeof BILLING_FEATURE = BILLING_FEATURE;
  /** {@linkcode REFUND_REQUEST_STATUS}. */
  static REFUND_REQUEST_STATUS: typeof REFUND_REQUEST_STATUS = REFUND_REQUEST_STATUS;
  /** {@linkcode PRORATION_MODE}. */
  static PRORATION_MODE: typeof PRORATION_MODE = PRORATION_MODE;
  /** {@linkcode STORE_REPLACEMENT_MODE}. */
  static STORE_REPLACEMENT_MODE: typeof STORE_REPLACEMENT_MODE = STORE_REPLACEMENT_MODE;
  /** {@linkcode PACKAGE_TYPE}. */
  static PACKAGE_TYPE: typeof PACKAGE_TYPE = PACKAGE_TYPE;
  /** {@linkcode INTRO_ELIGIBILITY_STATUS}. */
  static INTRO_ELIGIBILITY_STATUS: typeof INTRO_ELIGIBILITY_STATUS = INTRO_ELIGIBILITY_STATUS;
  /** {@linkcode PURCHASES_ERROR_CODE}. */
  static PURCHASES_ERROR_CODE: typeof PURCHASES_ERROR_CODE = PURCHASES_ERROR_CODE;
  /** {@linkcode LOG_LEVEL}. */
  static LOG_LEVEL: typeof LOG_LEVEL = LOG_LEVEL;
  /** {@linkcode IN_APP_MESSAGE_TYPE}. */
  static IN_APP_MESSAGE_TYPE: typeof IN_APP_MESSAGE_TYPE = IN_APP_MESSAGE_TYPE;
  /** {@linkcode ENTITLEMENT_VERIFICATION_MODE}. */
  static ENTITLEMENT_VERIFICATION_MODE: typeof ENTITLEMENT_VERIFICATION_MODE =
    ENTITLEMENT_VERIFICATION_MODE;
  /** {@linkcode VERIFICATION_RESULT}. */
  static VERIFICATION_RESULT: typeof VERIFICATION_RESULT = VERIFICATION_RESULT;
  /** {@linkcode STOREKIT_VERSION}. */
  static STOREKIT_VERSION: typeof STOREKIT_VERSION = STOREKIT_VERSION;
  /** {@linkcode PURCHASES_ARE_COMPLETED_BY_TYPE}. */
  static PURCHASES_ARE_COMPLETED_BY_TYPE: typeof PURCHASES_ARE_COMPLETED_BY_TYPE =
    PURCHASES_ARE_COMPLETED_BY_TYPE;
  /** {@linkcode UninitializedPurchasesError}. */
  static UninitializedPurchasesError: typeof UninitializedPurchasesError =
    UninitializedPurchasesError;
  /** {@linkcode UnsupportedPlatformError}. */
  static UnsupportedPlatformError: typeof UnsupportedPlatformError = UnsupportedPlatformError;

  /**
   * Configure the SDK once, early. Returns at once; the other calls wait for it.
   *
   * @param configuration The API key and, optionally, your user id.
   */
  static configure(configuration: PurchasesConfiguration): void {
    const { apiKey, appUserID } = configuration;
    ready = configurePurchases({ apiKey, ...(appUserID ? { appUserId: appUserID } : {}) });
    ready.catch(() => {});
  }

  /**
   * Whether {@linkcode Purchases.configure} finished.
   *
   * @returns Whether it did.
   */
  static async isConfigured(): Promise<boolean> {
    if (!ready) return false;
    try {
      await ready;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The offerings.
   *
   * @returns The offerings.
   */
  static getOfferings(): Promise<PurchaseOfferings> {
    return call(() => getOfferings());
  }

  /**
   * The offering a placement shows: the current offering.
   *
   * @param _placementIdentifier The placement (placements are not read).
   * @returns The current offering, or null.
   */
  static async getCurrentOfferingForPlacement(
    _placementIdentifier: string,
  ): Promise<PurchaseOffering | null> {
    return (await Purchases.getOfferings()).current;
  }

  /**
   * Buy a package.
   *
   * @param aPackage A package from the offerings.
   * @returns The product, customer info and transaction.
   */
  static async purchasePackage(aPackage: PurchasePackage): Promise<MakePurchaseResult> {
    const result = await call(() => purchasePackage(aPackage));
    publish(result.customerInfo);
    return result;
  }

  /**
   * Buy a store product (from {@linkcode Purchases.getProducts}).
   *
   * @param product The product.
   * @returns The product, customer info and transaction.
   */
  static async purchaseStoreProduct(product: unknown): Promise<MakePurchaseResult> {
    const result = await raw<MakePurchaseResult>("purchaseStoreProduct", { product });
    publish(result.customerInfo);
    return result;
  }

  /**
   * Restore purchases.
   *
   * @returns The customer info.
   */
  static async restorePurchases(): Promise<CustomerInfo> {
    return publish(await call(() => restorePurchases()));
  }

  /**
   * The customer info.
   *
   * @returns The customer info.
   */
  static async getCustomerInfo(): Promise<CustomerInfo> {
    return publish(await call(() => getCustomerInfo()));
  }

  /**
   * Products by id.
   *
   * @param productIdentifiers The ids.
   * @param type The category (default subscriptions).
   * @returns The products.
   */
  static async getProducts(
    productIdentifiers: string[],
    type: string = PRODUCT_CATEGORY.SUBSCRIPTION,
  ): Promise<unknown[]> {
    const out = await raw<{ products?: unknown[] }>("getProducts", { productIdentifiers, type });
    return out?.products ?? [];
  }

  /**
   * Switch to your user id.
   *
   * @param appUserID Your user id.
   * @returns The customer info and whether a user was created.
   */
  static async logIn(appUserID: string): Promise<LogInResult> {
    const result = await raw<LogInResult>("logIn", { appUserID });
    publish(result.customerInfo);
    return result;
  }

  /**
   * Switch back to an anonymous user.
   *
   * @returns The customer info.
   */
  static async logOut(): Promise<CustomerInfo> {
    const out = await raw<{ customerInfo: CustomerInfo }>("logOut");
    return publish(out.customerInfo);
  }

  /**
   * The current app user id.
   *
   * @returns The id.
   */
  static async getAppUserID(): Promise<string> {
    return (await raw<{ appUserID: string }>("getAppUserID")).appUserID;
  }

  /**
   * Whether the current user is anonymous.
   *
   * @returns Whether it is.
   */
  static async isAnonymous(): Promise<boolean> {
    return (await raw<{ isAnonymous: boolean }>("isAnonymous")).isAnonymous;
  }

  /**
   * Sync purchases made outside the SDK.
   *
   * @returns A promise that settles once synced.
   */
  static async syncPurchases(): Promise<void> {
    await raw("syncPurchases");
  }

  /**
   * Drop the cached customer info.
   *
   * @returns A promise that settles once dropped.
   */
  static async invalidateCustomerInfoCache(): Promise<void> {
    await raw("invalidateCustomerInfoCache");
  }

  /**
   * Whether this device can make payments.
   *
   * @param features Google Play billing features to require.
   * @returns Whether it can.
   */
  static async canMakePayments(features: BILLING_FEATURE[] = []): Promise<boolean> {
    return (await raw<{ canMakePayments: boolean }>("canMakePayments", { features }))
      .canMakePayments;
  }

  /**
   * Open the store's subscription management.
   *
   * @returns A promise that settles once shown.
   */
  static async showManageSubscriptions(): Promise<void> {
    await raw("showManageSubscriptions");
  }

  /**
   * Set the SDK's log level.
   *
   * @param level The level.
   * @returns A promise that settles once set.
   */
  static async setLogLevel(level: LOG_LEVEL): Promise<void> {
    await raw("setLogLevel", { level });
  }

  /**
   * Turn debug logs on or off.
   *
   * @param enabled On or off.
   * @returns A promise that settles once set.
   */
  static setDebugLogsEnabled(enabled: boolean): Promise<void> {
    return Purchases.setLogLevel(enabled ? LOG_LEVEL.DEBUG : LOG_LEVEL.INFO);
  }

  /**
   * Set a log handler. The plugin logs natively, so it is not called.
   *
   * @param _logHandler The handler.
   */
  static setLogHandler(_logHandler: LogHandler): void {}

  /**
   * Listen for customer info updates (after purchases, restores, log-ins and reads).
   *
   * @param customerInfoUpdateListener The listener.
   */
  static addCustomerInfoUpdateListener(
    customerInfoUpdateListener: CustomerInfoUpdateListener,
  ): void {
    listeners.add(customerInfoUpdateListener);
  }

  /**
   * Stop listening.
   *
   * @param listenerToRemove The listener.
   * @returns Whether it was listening.
   */
  static removeCustomerInfoUpdateListener(listenerToRemove: CustomerInfoUpdateListener): boolean {
    return listeners.delete(listenerToRemove);
  }

  /**
   * Set subscriber attributes.
   *
   * @param attributes Name → value (null removes one).
   * @returns A promise that settles once set.
   */
  static async setAttributes(attributes: Record<string, string | null>): Promise<void> {
    await raw("setAttributes", attributes);
  }

  /**
   * Set the subscriber's email.
   *
   * @param email The email (null removes it).
   * @returns A promise that settles once set.
   */
  static async setEmail(email: string | null): Promise<void> {
    await raw("setEmail", { email });
  }

  /**
   * Set the subscriber's phone number.
   *
   * @param phoneNumber The number (null removes it).
   * @returns A promise that settles once set.
   */
  static async setPhoneNumber(phoneNumber: string | null): Promise<void> {
    await raw("setPhoneNumber", { phoneNumber });
  }

  /**
   * Set the subscriber's display name.
   *
   * @param displayName The name (null removes it).
   * @returns A promise that settles once set.
   */
  static async setDisplayName(displayName: string | null): Promise<void> {
    await raw("setDisplayName", { displayName });
  }

  /**
   * Set the subscriber's push token.
   *
   * @param pushToken The token (null removes it).
   * @returns A promise that settles once set.
   */
  static async setPushToken(pushToken: string | null): Promise<void> {
    await raw("setPushToken", { pushToken });
  }
}

/** Forget the configuration and listeners (for tests). */
export function resetPurchasesCompatForTesting(): void {
  ready = null;
  listeners.clear();
}
