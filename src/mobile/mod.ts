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
 * - In a Deno Desktop window ({@linkcode runtimePlatform} `"desktop"`), `secureStore`, the
 *   file functions, `openSqlite`, `openExternal`, `pickDocument`, `useKeepAwake`,
 *   `deviceInfo`, the clipboard (text, HTML and images), `showContextMenu` (the OS menu), the
 *   local notifications (scheduled, with click routing) and `setQuickActions` (the macOS Dock
 *   menu) go through the desktop runtime's capabilities (`denext desktop add <capability>`;
 *   the menus and notifications need denext's pinned runtime, else they keep their web path);
 *   {@linkcode openPath},
 *   {@linkcode revealInFileManager}, {@linkcode moveToTrash}, {@linkcode saveFile} and
 *   {@linkcode pickFolder} are the desktop file-manager and dialog extras. A picked file or
 *   folder comes back with an opaque `handle` ({@linkcode PickedHandle}): the file functions
 *   reach it as `{ directory: { picked: handle } }` (a browser with the File System Access API
 *   issues page-lifetime handles too); its `path` is display-only.
 * - {@linkcode installKeyboardInset} / {@linkcode useKeyboardInset}: the keyboard height as
 *   `--denext-keyboard-inset`, for shells with Keyboard `resize: "none"`.
 * - {@linkcode useBackSwipe} / {@linkcode isBackSwipe}: swipe right to go back.
 * - {@linkcode installMomentumSafeScroll} / {@linkcode useMomentumSafeScroll}: keep iOS
 *   momentum scrolling alive while virtualized lists correct the scroll offset mid-fling.
 * - {@linkcode SAFE_AREA_CSS}: `--denext-safe-*` custom properties (needs `viewport-fit=cover`);
 *   {@linkcode useSafeAreaInsets}: the same insets as numbers, live.
 * - {@linkcode useKeyboard} / {@linkcode onKeyboardChange}: the keyboard's visibility and height
 *   (`@capacitor/keyboard`'s will-show / will-hide in the shell, the visual viewport on the
 *   web); {@linkcode KeyboardAvoidingView} / {@linkcode KeyboardStickyView} move out of its
 *   way; {@linkcode hideKeyboard} / {@linkcode setKeyboardResizeMode}.
 * - {@linkcode onBack} / {@linkcode useBackHandler}: a LIFO stack of handlers for Android's
 *   back button and gesture (the browser's back button on the web);
 *   {@linkcode onBackProgress} / {@linkcode useBackProgress}: the predictive-back gesture's
 *   progress (`denext mobile add back`).
 * - {@linkcode setSystemBars} / {@linkcode useSystemBarsFollowTheme}: the status and
 *   navigation bars' style and visibility (Capacitor 8's `SystemBars`).
 * - {@linkcode PullToRefresh}: a scroll container with a touch pull-to-refresh gesture and
 *   spinner (React Native mode's `RefreshControl` shares it); {@linkcode RefreshControl}: the
 *   same around a scroll container you already render (`VirtualList`'s `refreshControl`).
 * - {@linkcode checkForUiUpdate} / {@linkcode otaBooted} / {@linkcode otaStatus} /
 *   {@linkcode otaReset}: over-the-air UI updates through the native `DenextOta` plugin
 *   that `denext mobile add-ota` installs, which re-verifies a downloaded UI whenever it serves
 *   it ({@linkcode onOtaRejected} hears a refusal); {@linkcode prepareUiUpdate} /
 *   {@linkcode applyUiUpdate} split the download from the switch for an app's own prompt;
 *   {@linkcode otaSignaturePayload} builds the exact bytes a manifest signature covers.
 * - Native capabilities, each through its official Capacitor plugin in the shell
 *   (`denext mobile add <capability>` installs it) and a web fallback elsewhere:
 *   {@linkcode haptic}, {@linkcode readClipboard} / {@linkcode writeClipboard} /
 *   {@linkcode clipboardFormats},
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
 *   links that open the app, filtered and routed (`denext mobile add deep-links`; on Deno Desktop
 *   the schemes of `desktop.app.deepLinks`). {@linkcode onOpenFile} / {@linkcode useOpenFile}: the
 *   files the OS opens with a Deno Desktop app, as read-only picked handles.
 * - {@linkcode openAuthSession}: OAuth / OIDC sign-in in a system browser sheet
 *   (ASWebAuthenticationSession on iOS, a Custom Tab on Android, a popup finished by
 *   {@linkcode completeAuthSession} on the web), resolving with the callback URL
 *   (`denext mobile add auth-session --scheme myapp`).
 * - {@linkcode requestPushPermission}, {@linkcode registerForPush} (the APNs / FCM token for
 *   your server), {@linkcode onPushReceived} / {@linkcode usePushReceived} and
 *   {@linkcode onPushTapped} / {@linkcode usePushTapped} (`denext mobile add push`; no
 *   web-push fallback).
 * - {@linkcode checkPermission} / {@linkcode requestPermission} / {@linkcode usePermission}: one
 *   permission status across iOS, Android and the web; {@linkcode openAppSettings} for a
 *   `blocked` one (`denext mobile add permissions`).
 * - {@linkcode scheduleNotification} and the rest of the local-notification API: triggers,
 *   Android channels, categories with action buttons, {@linkcode onLocalNotificationTapped}
 *   (`denext mobile add local-notifications`).
 * - {@linkcode isBiometricAvailable} / {@linkcode authenticateBiometric} (`denext mobile add
 *   biometrics`), and `secureStore.set(key, value, { requireBiometric: true })`.
 * - {@linkcode signInWithApple} / {@linkcode signInWithGoogle} / {@linkcode signInNative}: the
 *   native sign-in sheets, verified by a denext server (`denext mobile add social-login`).
 * - {@linkcode getCurrentPosition} / {@linkcode watchPosition} / {@linkcode useLocation}
 *   (`denext mobile add geolocation`; `navigator.geolocation` on the web).
 * - {@linkcode watchPositionInBackground} / {@linkcode stopBackgroundLocation}: location that
 *   keeps arriving in the background (`denext mobile add background-location`; the foreground
 *   watch on the web).
 * - {@linkcode openKeyValueStore}: durable key-value storage in the app's data folder, which the
 *   OS does not evict the way it may evict WebView storage (`denext mobile add storage`;
 *   IndexedDB on the web). React Native mode's AsyncStorage and MMKV run on it.
 * - {@linkcode isScreenReaderEnabled} / {@linkcode onScreenReaderChange} /
 *   {@linkcode useScreenReader}: VoiceOver / TalkBack state (`denext mobile add accessibility`;
 *   `false` on the web).
 * - {@linkcode getFontScale} / {@linkcode useFontScale} / {@linkcode onFontScaleChange}: the OS
 *   text size (Dynamic Type, Android's font scale) as the factor the page must apply;
 *   {@linkcode applyFontScale} opts the root font size in (`denext mobile add accessibility`;
 *   1 on the web).
 * - {@linkcode configurePurchases}, {@linkcode getOfferings}, {@linkcode purchasePackage},
 *   {@linkcode restorePurchases}, {@linkcode getCustomerInfo}, {@linkcode useEntitlement}:
 *   in-app purchases through RevenueCat (`denext mobile add purchases`; no web fallback).
 * - {@linkcode requestReview} / {@linkcode openStoreReview} (`mobile add app-review`),
 *   {@linkcode getAppUpdateInfo} / {@linkcode promptStoreUpdate} and Android's in-app updates
 *   (`mobile add app-update`), {@linkcode lockOrientation} / {@linkcode useOrientation}
 *   (`mobile add screen-orientation`), {@linkcode saveToLibrary} / {@linkcode getAlbums}
 *   (`mobile add media-library`), {@linkcode usePrivacyScreen} (`mobile add privacy-screen`),
 *   {@linkcode requestTrackingPermission} (`mobile add tracking`, iOS ATT),
 *   {@linkcode defineBackgroundTask} (`mobile add background`), and
 *   {@linkcode onRestoredResult} / {@linkcode restoreRouteOnRelaunch} for Android process death
 *   (`mobile add restore`).
 * - {@linkcode showContextMenu} / {@linkcode useContextMenu} / {@linkcode attachContextMenu}:
 *   native menus (`UIContextMenuInteraction` with the lifted preview and `UIMenu` on iOS,
 *   `PopupMenu` on Android; `denext mobile add context-menu`), an in-page popover elsewhere.
 * - {@linkcode SystemIcon}: the SF Symbol, rendered natively in the iOS shell (`denext mobile
 *   add system-icons`), a Material Symbol everywhere else.
 * - {@linkcode initCrashReporting}: Sentry's Capacitor SDK with the OTA UI version as the release
 *   (`mobile add sentry`); {@linkcode installOfflineScreen}: a full-screen notice while the
 *   device is offline (`mobile add offline-screen`).
 * - {@linkcode NativeViewSlot} / {@linkcode useNativeViewSlot}: a native view (a map, a video
 *   player, your own registered view type) kept on a box in the page layout, with its children
 *   as the web fallback (`mobile add native-views`, `mobile add native-map`).
 * - {@linkcode nativeModule} / {@linkcode onNativeEvent}: a typed client for your own native
 *   plugin (a Capacitor plugin in the shell, e.g. from `denext mobile add native-module --name
 *   <Name>`; a desktop extension in a Deno Desktop window); every call is async.
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
export {
  readSafeAreaInsets,
  SAFE_AREA_CSS,
  type SafeAreaInsets,
  useSafeAreaInsets,
  watchSafeAreaInsets,
} from "./safe-area.ts";
export {
  hideKeyboard,
  type KeyboardResizeMode,
  type KeyboardState,
  onKeyboardChange,
  setKeyboardResizeMode,
  useKeyboard,
} from "./keyboard-state.ts";
export {
  type KeyboardAvoidingBehavior,
  KeyboardAvoidingView,
  type KeyboardAvoidingViewProps,
  KeyboardStickyView,
  type KeyboardStickyViewProps,
  type KeyboardViewStyle,
} from "./keyboard-views.ts";
export {
  type BackEdge,
  type BackGesture,
  type BackHandler,
  type BackProgressEvent,
  onBack,
  onBackProgress,
  useBackHandler,
  useBackProgress,
} from "./back-handler.ts";
export {
  setSystemBars,
  type SystemBar,
  type SystemBarsOptions,
  type SystemBarsStyle,
  useSystemBarsFollowTheme,
} from "./system-bars.ts";
export {
  PullToRefresh,
  type PullToRefreshProps,
  type PullToRefreshStyle,
} from "./pull-to-refresh.ts";
export { RefreshControl, type RefreshControlProps } from "./refresh-control.ts";
export {
  installMomentumSafeScroll,
  type MomentumSafeScrollOptions,
  useMomentumSafeScroll,
} from "./momentum.ts";
export {
  applyUiUpdate,
  checkForUiUpdate,
  onOtaRejected,
  type OtaApplyResult,
  otaBooted,
  type OtaCheckOptions,
  type OtaCheckResult,
  type OtaErrorCode,
  otaInstallId,
  type OtaPrepareResult,
  type OtaRejectedEvent,
  otaReset,
  type OtaStatus,
  otaStatus,
  prepareUiUpdate,
} from "./ota.ts";
export { type OtaManifest, type OtaManifestFile, otaSignaturePayload } from "./ota-manifest.ts";
export { haptic, type HapticKind } from "./haptics.ts";
export {
  type ClipboardContent,
  type ClipboardFormat,
  clipboardFormats,
  readClipboard,
  type ReadClipboardOptions,
  writeClipboard,
} from "./clipboard.ts";
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
export {
  type SecureStore,
  secureStore,
  type SecureStoreGetOptions,
  type SecureStoreSetOptions,
} from "./secure-store.ts";
export { type DeepLinkEvent, type DeepLinkOptions, onDeepLink, useDeepLink } from "./deep-link.ts";
export { onOpenFile, type OpenedFile, useOpenFile } from "./open-file.ts";
export type { LinkAccept, LinkAllowList, LinkRoute } from "./link-routing.ts";
export {
  type AuthCancelOverlayText,
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
  type AppFileDirectory,
  deleteFile,
  downloadToFile,
  type FileDirectory,
  type FileEncoding,
  type FileEntry,
  type FileLocationOptions,
  listDir,
  type PickedDirectory,
  type PickedHandle,
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
  type PickedFolder,
  pickFolder,
  type SavedFile,
  saveFile,
  type SaveFileOptions,
} from "./file-dialogs.ts";
export { moveToTrash, openPath, revealInFileManager, type ShellItem } from "./shell.ts";
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
export {
  attachContextMenu,
  type ContextMenuElement,
  type ContextMenuItems,
  type ContextMenuTargetOptions,
  type PressEvent,
  useContextMenu,
} from "./context-menu-target.ts";
export {
  materialNameFor,
  preloadSystemIcons,
  registerSystemIcons,
  SystemIcon,
  type SystemIconMode,
  type SystemIconProps,
  type SystemIconWeight,
} from "./system-icon.ts";
export {
  checkPermission,
  openAppSettings,
  type PermissionError,
  type PermissionErrorCode,
  type PermissionHandle,
  type PermissionName,
  type PermissionState,
  requestPermission,
  usePermission,
  type UsePermissionOptions,
} from "./permissions.ts";
export {
  type CalendarComponents,
  cancelAllNotifications,
  cancelNotification,
  createNotificationChannel,
  deleteNotificationChannel,
  listNotificationChannels,
  type LocalNotification,
  type LocalNotificationInput,
  type LocalNotificationTap,
  type LocalNotificationTapOptions,
  type LocalNotificationTrigger,
  type NotificationAction,
  type NotificationCategory,
  type NotificationChannel,
  onLocalNotificationReceived,
  onLocalNotificationTapped,
  pendingNotifications,
  type ScheduledLocalNotification,
  scheduleNotification,
  setNotificationCategories,
  useLocalNotificationTapped,
} from "./local-notifications.ts";
export {
  authenticateBiometric,
  type BiometricAuthOptions,
  type BiometricAvailability,
  type BiometricError,
  type BiometricErrorCode,
  type BiometricType,
  isBiometricAvailable,
} from "./biometrics.ts";
export {
  type AppleSignInOptions,
  type GoogleSignInOptions,
  type IdTokenSession,
  signInNative,
  signInWithApple,
  signInWithGoogle,
  type SocialSignInError,
  type SocialSignInErrorCode,
  type SocialSignInResult,
} from "./social-login.ts";
export {
  type GeolocationError,
  type GeolocationErrorCode,
  type GeoPosition,
  type GeoPositionOptions,
  getCurrentPosition,
  type LocationState,
  useLocation,
  type UseLocationOptions,
  watchPosition,
} from "./geolocation.ts";
export {
  configurePurchases,
  type CustomerInfo,
  type EntitlementInfo,
  type EntitlementState,
  getCustomerInfo,
  getOfferings,
  type PurchaseOffering,
  type PurchaseOfferings,
  type PurchasePackage,
  purchasePackage,
  type PurchaseProduct,
  type PurchaseResult,
  type PurchasesConfig,
  type PurchasesError,
  type PurchasesErrorCode,
  restorePurchases,
  useEntitlement,
} from "./purchases.ts";
export {
  openStoreReview,
  requestReview,
  type ReviewRequestResult,
  type StoreListingOptions,
} from "./app-review.ts";
export {
  type AppStoreOptions,
  type AppUpdateAvailability,
  type AppUpdateInfo,
  type AppUpdateOutcome,
  completeFlexibleUpdate,
  type FlexibleUpdateProgress,
  getAppUpdateInfo,
  onFlexibleUpdateProgress,
  openAppStore,
  performImmediateUpdate,
  promptStoreUpdate,
  type PromptStoreUpdateOptions,
  type PromptStoreUpdateResult,
  startFlexibleUpdate,
} from "./app-update.ts";
export {
  getOrientation,
  lockOrientation,
  onOrientationChange,
  type Orientation,
  type OrientationLock,
  unlockOrientation,
  useOrientation,
} from "./screen-orientation.ts";
export {
  createAlbum,
  getAlbums,
  getRecentMedia,
  type MediaAlbum,
  type MediaItem,
  type RecentMediaOptions,
  type SavedMedia,
  saveToLibrary,
  type SaveToLibraryOptions,
} from "./media-library.ts";
export { type PrivacyScreenOptions, setPrivacyScreen, usePrivacyScreen } from "./privacy-screen.ts";
export { getTrackingStatus, requestTrackingPermission, type TrackingStatus } from "./tracking.ts";
export {
  type BackgroundKeyValue,
  type BackgroundTask,
  type BackgroundTaskContext,
  type BackgroundTaskDefinition,
  defineBackgroundTask,
  runBackgroundTask,
} from "./background.ts";
export {
  onRestoredResult,
  type RestoredResult,
  restoreRouteOnRelaunch,
  type RestoreRouteOptions,
  useRestoredResult,
} from "./restore.ts";
export {
  type CrashReportingOptions,
  type CrashReportingStarted,
  initCrashReporting,
  type SentryCapacitorSdk,
  type SentrySiblingSdk,
} from "./crash-reporting.ts";
export { installOfflineScreen, type OfflineScreenOptions } from "./offline-screen.ts";
export {
  applyFontScale,
  type ApplyFontScaleOptions,
  getFontScale,
  isScreenReaderEnabled,
  onFontScaleChange,
  onScreenReaderChange,
  useFontScale,
  useReducedMotion,
  useScreenReader,
} from "./accessibility.ts";
export { type KeyValueBackend, type KeyValueStore, openKeyValueStore } from "./kv-store.ts";
export {
  nativeViewEmbedScroller,
  type NativeViewPlacement,
  type NativeViewPlacementOption,
  type NativeViewScrollPassthrough,
  NativeViewSlot,
  type NativeViewSlotHandle,
  type NativeViewSlotOptions,
  type NativeViewSlotProps,
  type NativeViewSlotStyle,
  type NativeViewStatus,
  useNativeViewSlot,
} from "./native-view.ts";
export {
  type BackgroundLocationOptions,
  isBackgroundLocationAvailable,
  stopBackgroundLocation,
  watchPositionInBackground,
} from "./background-location.ts";
export {
  type NativeCallConvention,
  type NativeMethod,
  nativeModule,
  type NativeModuleClient,
  type NativeModuleEvents,
  type NativeModuleMethods,
  type NativeModuleOptions,
  type NativeSubscription,
  onNativeEvent,
} from "./native-module.ts";
