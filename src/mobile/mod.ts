/**
 * `denext/mobile` — a tiny client runtime for apps that ship inside a Capacitor iOS/Android
 * shell (webview origin `capacitor://localhost` on iOS, `https://localhost` on Android).
 *
 * It costs nothing on the web: importing it runs no code, every export is independently
 * tree-shakable, and it has no `@capacitor/*` dependency. It talks to the native side only
 * through the `window.Capacitor` global the shell injects before page scripts, so on the web
 * (and during SSR) every function takes its plain-browser path.
 *
 * - {@linkcode isNativeShell} / {@linkcode nativePlatform}: are we in the shell, and which one.
 * - {@linkcode onAppResume} / {@linkcode useAppResume}: foreground return plus time away, for
 *   probe-vs-reconnect decisions (under 10 s: probe; 10 s or more: reconnect and refetch).
 * - {@linkcode openExternal}: the in-app browser via the native `Browser` plugin, else
 *   `window.open` with `noopener`; only http(s), mailto: and tel: are allowed.
 * - {@linkcode installKeyboardInset} / {@linkcode useKeyboardInset}: the keyboard height as
 *   `--denext-keyboard-inset`, for shells with Keyboard `resize: "none"`.
 * - {@linkcode useBackSwipe} / {@linkcode isBackSwipe}: swipe right to go back.
 * - {@linkcode installMomentumSafeScroll} / {@linkcode useMomentumSafeScroll}: keep iOS
 *   momentum scrolling alive while virtualized lists correct the scroll offset mid-fling.
 * - {@linkcode SAFE_AREA_CSS}: `--denext-safe-*` custom properties (needs `viewport-fit=cover`).
 * - {@linkcode checkForUiUpdate} / {@linkcode otaBooted} / {@linkcode otaStatus} /
 *   {@linkcode otaReset}: over-the-air UI updates through the native `DenextOta` plugin
 *   that `denext mobile add-ota` installs; {@linkcode prepareUiUpdate} /
 *   {@linkcode applyUiUpdate} split the download from the switch for an app's own prompt;
 *   {@linkcode otaSignaturePayload} builds the exact bytes a manifest signature covers.
 * - Native capabilities, each through its official Capacitor plugin in the shell
 *   (`denext mobile add <capability>` installs it) and a web fallback elsewhere:
 *   {@linkcode haptic}, {@linkcode readClipboard} / {@linkcode writeClipboard},
 *   {@linkcode share}, {@linkcode deviceInfo}, {@linkcode networkStatus} /
 *   {@linkcode useNetworkStatus}, {@linkcode useKeepAwake}, {@linkcode hideSplash} and
 *   {@linkcode secureStore} (Keychain / Keystore natively; NOT secret on the web).
 * - Files and media: {@linkcode readFile} / {@linkcode writeFile} / {@linkcode deleteFile} /
 *   {@linkcode listDir} / {@linkcode downloadToFile} (app storage natively, OPFS on the web),
 *   {@linkcode pickImage} (camera or photo library) and {@linkcode pickDocument} (the system
 *   document picker; both a hidden file input on the web), and {@linkcode scanBarcode}
 *   (`BarcodeDetector` over the camera on the web).
 * - {@linkcode setQuickActions} / {@linkcode onQuickAction} / {@linkcode useQuickAction}:
 *   home-screen quick actions (long-press on the app icon), cold-start action included.
 * - {@linkcode onDeepLink} / {@linkcode useDeepLink}: the custom-scheme and universal / app
 *   links that open the app, filtered and routed (`denext mobile add deep-links`).
 * - {@linkcode openAuthSession}: OAuth / OIDC sign-in in a system browser sheet
 *   (ASWebAuthenticationSession on iOS, a Custom Tab on Android, a popup finished by
 *   {@linkcode completeAuthSession} on the web), resolving with the callback URL
 *   (`denext mobile add auth-session --scheme myapp`).
 * - {@linkcode requestPushPermission}, {@linkcode registerForPush} (the APNs / FCM token for
 *   your server), {@linkcode onPushReceived} / {@linkcode usePushReceived} and
 *   {@linkcode onPushTapped} / {@linkcode usePushTapped} (`denext mobile add push`; no
 *   web-push fallback).
 *
 * @example
 * ```tsx
 * "use client";
 * import { useRouter } from "denext";
 * import { isNativeShell, useAppResume, useBackSwipe, useKeyboardInset } from "denext/mobile";
 *
 * export function Shell({ children }: { children: unknown }) {
 *   const router = useRouter();
 *   useAppResume((awayMs) => (awayMs < 10_000 ? live.probe() : live.reconnect()));
 *   const inset = useKeyboardInset();
 *   const swipeRef = useBackSwipe(() => router.back(), { enabled: isNativeShell() });
 *   return (
 *     <main ref={swipeRef} style={{ touchAction: "pan-y", paddingBottom: inset }}>
 *       {children}
 *     </main>
 *   );
 * }
 * ```
 *
 * @module
 */

export { isNativeShell, type NativePlatform, nativePlatform, openExternal } from "./bridge.ts";
export { type RuntimePlatform, runtimePlatform } from "./bridge.ts";
export { onAppResume, useAppResume } from "./resume.ts";
export { installKeyboardInset, type KeyboardInsetOptions, useKeyboardInset } from "./keyboard.ts";
export { type BackSwipeOptions, isBackSwipe, useBackSwipe } from "./back-swipe.ts";
export { SAFE_AREA_CSS } from "./safe-area.ts";
export {
  installMomentumSafeScroll,
  type MomentumSafeScrollOptions,
  useMomentumSafeScroll,
} from "./momentum.ts";
export {
  applyUiUpdate,
  checkForUiUpdate,
  type OtaApplyResult,
  otaBooted,
  type OtaCheckOptions,
  type OtaCheckResult,
  type OtaErrorCode,
  type OtaPrepareResult,
  otaReset,
  type OtaStatus,
  otaStatus,
  prepareUiUpdate,
} from "./ota.ts";
export { type OtaManifest, type OtaManifestFile, otaSignaturePayload } from "./ota-manifest.ts";
export { haptic, type HapticKind } from "./haptics.ts";
export { readClipboard, writeClipboard } from "./clipboard.ts";
export { share, type ShareOptions, type ShareResult } from "./share.ts";
export { type DeviceInfo, deviceInfo } from "./device.ts";
export {
  type NetworkConnectionType,
  type NetworkStatus,
  networkStatus,
  useNetworkStatus,
} from "./network.ts";
export { useKeepAwake } from "./keep-awake.ts";
export { hideSplash } from "./splash.ts";
export { type SecureStore, secureStore } from "./secure-store.ts";
export { type DeepLinkEvent, type DeepLinkOptions, onDeepLink, useDeepLink } from "./deep-link.ts";
export type { LinkAccept, LinkAllowList, LinkRoute } from "./link-routing.ts";
export {
  type AuthSessionError,
  type AuthSessionErrorCode,
  type AuthSessionOptions,
  type AuthSessionResult,
  completeAuthSession,
  openAuthSession,
} from "./auth-session.ts";
export {
  onPushReceived,
  onPushTapped,
  type PushNotification,
  type PushPermission,
  type PushRegistration,
  type PushTap,
  type PushTapOptions,
  registerForPush,
  type RegisterForPushOptions,
  requestPushPermission,
  usePushReceived,
  usePushTapped,
} from "./push.ts";
export {
  deleteFile,
  downloadToFile,
  type FileDirectory,
  type FileEncoding,
  type FileEntry,
  type FileLocationOptions,
  listDir,
  readFile,
  type ReadFileOptions,
  writeFile,
  type WriteFileOptions,
} from "./filesystem.ts";
export {
  type ImageSource,
  pickDocument,
  type PickDocumentOptions,
  type PickedDocument,
  type PickedImage,
  pickImage,
  type PickImageOptions,
} from "./pickers.ts";
export {
  type BarcodeFormat,
  type BarcodeScanError,
  type BarcodeScanErrorCode,
  scanBarcode,
  type ScanBarcodeOptions,
  type ScannedBarcode,
} from "./barcode.ts";
export {
  onQuickAction,
  type QuickAction,
  setQuickActions,
  useQuickAction,
} from "./quick-actions.ts";
export {
  deleteSqlite,
  openSqlite,
  type SqliteBackend,
  type SqliteBindValue,
  type SqliteDatabase,
  type SqliteOptions,
  type SqliteParams,
  type SqliteRow,
  type SqliteRows,
  type SqliteRunResult,
  type SqliteValue,
  type SqliteWasmUrls,
} from "./sqlite.ts";
export * from "./share-receive.ts";
export * from "./widgets.ts";
export * from "./live-activity.ts";
export { type ContextMenuItem, type ContextMenuOptions, showContextMenu } from "./context-menu.ts";
