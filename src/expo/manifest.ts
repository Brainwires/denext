/**
 * The `denext/expo/*` shim manifest: which `expo-*` package each shim stands in for, the
 * version its API was matched against (T3 Code's `apps/mobile`, Expo SDK 57), how complete
 * it is, and what it leaves out.
 *
 * React Native mode (`reactNative` in `denext.config.ts`) aliases every package listed here
 * to its shim; a package not listed resolves normally. `scripts/parity` checks each shim's
 * exports against the pinned package's types. Pure data: no imports, nothing runs.
 *
 * @example
 * ```ts
 * import { EXPO_SHIMS } from "denext/expo/manifest";
 *
 * for (const [pkg, shim] of Object.entries(EXPO_SHIMS)) console.log(pkg, shim.status);
 * ```
 *
 * @module
 */

/** One shim. */
export interface ExpoShim {
  /** The shim module, relative to `src/expo` (`"./haptics.ts"`). */
  readonly module: string;
  /** The package version its API was matched against. */
  readonly pinned: string;
  /**
   * `full`: the package's API, backed for real. `partial`: the commonly used API, with
   * `omitted` exports or documented differences. `stub`: native-only or config-only, loads
   * but does nothing.
   */
  readonly status: "full" | "partial" | "stub";
  /** Exports deliberately not provided. */
  readonly omitted?: readonly string[];
  /** Why (sync JSI APIs, native-only, …). */
  readonly notes?: string;
}

/** Every `expo-*` package React Native mode aliases, by package name. */
export const EXPO_SHIMS: Readonly<Record<string, ExpoShim>> = {
  "expo": {
    module: "./expo.ts",
    pinned: "57.0.18",
    status: "partial",
    notes: "registerRootComponent mounts through react-native-web's AppRegistry, so the app's " +
      "own index.ts is the web entry. No native modules: requireNativeModule throws, " +
      "requireOptionalNativeModule returns null, requireNativeView renders nothing. " +
      "`expo/fetch` resolves here too (the platform fetch).",
  },
  "expo-asset": {
    module: "./asset.ts",
    pinned: "57.0.15",
    status: "partial",
    notes: "An asset is the bundled file's URL; numeric Metro asset ids are not supported.",
  },
  "expo-audio": {
    module: "./audio.ts",
    pinned: "57.0.4",
    status: "partial",
    omitted: [
      "useAudioSampleListener",
      "useAudioPlaylist",
      "useAudioPlaylistStatus",
      "createAudioPlaylist",
      "useAudioStream",
      "preload",
      "clearPreloadedSource",
      "clearAllPreloadedSources",
      "getPreloadedSources",
      "requestNotificationPermissionsAsync",
      "AudioModule",
      "IOSOutputFormat",
    ],
    notes: "Playback over HTMLAudioElement, recording over MediaRecorder (WebM/MP4, metering " +
      "from a Web Audio analyser). Audio-session calls resolve without effect.",
  },
  "expo-auth-session": {
    module: "./auth-session.ts",
    pinned: "57.0.10",
    status: "partial",
    omitted: [
      "AccessTokenRequest",
      "RefreshTokenRequest",
      "RevokeTokenRequest",
      "TokenRequest",
      "Request",
      "ResponseError",
      "TokenError",
      "useLoadedAuthRequest",
      "useAuthRequestResult",
      "requestAsync",
    ],
    notes: "AuthRequest (PKCE S256), useAuthRequest, discovery and the token calls over " +
      "openAuthSession. Provider presets (expo-auth-session/providers/*) are not shimmed.",
  },
  "expo-blur": {
    module: "./blur.ts",
    pinned: "57.0.2",
    status: "partial",
    notes: "A CSS backdrop-filter blur with a tint overlay; system material tints map to " +
      "light/dark/default.",
  },
  "expo-build-properties": {
    module: "./build-properties.ts",
    pinned: "57.0.15",
    status: "stub",
    notes: "A config plugin for native prebuild; withBuildProperties returns the config unchanged.",
  },
  "expo-camera": {
    module: "./camera.ts",
    pinned: "57.0.4",
    status: "partial",
    omitted: ["PictureRef"],
    notes: "Permissions and barcode scanning only: CameraView with onBarcodeScanned opens " +
      "denext's full-screen scanner (Capacitor barcode plugin / BarcodeDetector) instead of an " +
      "inline preview. No photo capture or recording (takePictureAsync, recordAsync).",
  },
  "expo-clipboard": {
    module: "./clipboard.ts",
    pinned: "57.0.1",
    status: "partial",
    omitted: ["getImageAsync", "setImageAsync", "ClipboardPasteButton"],
    notes: "Text only; the change listener is never called (neither platform reports changes).",
  },
  "expo-constants": {
    module: "./constants.ts",
    pinned: "57.0.16",
    status: "partial",
    notes: "expoConfig comes from globalThis.__DENEXT_EXPO_CONFIG__ (set it before the bundle " +
      "runs); manifest/manifest2 are null; appOwnership null, executionEnvironment standalone.",
  },
  "expo-crypto": {
    module: "./crypto.ts",
    pinned: "57.0.2",
    status: "partial",
    omitted: ["aesEncryptAsync", "aesDecryptAsync", "AESEncryptionKey", "AESSealedData"],
    notes: "WebCrypto: SHA-1/SHA-2 digests, random bytes and UUIDs. MD2/MD4/MD5 reject.",
  },
  "expo-dev-client": {
    module: "./dev-client.ts",
    pinned: "57.0.16",
    status: "stub",
    notes: "Expo's native dev launcher; the dev-menu calls do nothing (use `denext dev`).",
  },
  "expo-device": {
    module: "./device.ts",
    pinned: "57.0.1",
    status: "partial",
    notes: "The constants are synchronous in Expo (JSI); here they come from the user agent, " +
      "read once. Facts a web view cannot learn (brand, memory, build ids) are null.",
  },
  "expo-document-picker": {
    module: "./document-picker.ts",
    pinned: "57.0.1",
    status: "partial",
    notes: "One document per pick (`multiple` picks one); on the web the uri is a data: URL.",
  },
  "expo-file-system": {
    module: "./file-system.ts",
    pinned: "57.0.6",
    status: "partial",
    omitted: [
      "FileHandle",
      "UploadTask",
      "DownloadTask",
    ],
    notes: "SDK 57's object API (File, Directory, Paths). Expo's API is synchronous (JSI); " +
      "the Capacitor bridge and OPFS are not, so sync calls act on an index kept in " +
      "localStorage and reach the files in order in the background; async readers wait for " +
      "them, and the *Sync readers answer only for files written or read this session. Not " +
      "provided: open()/file handles, streams, watch(), upload/download tasks, pickers " +
      "(File.pickFileAsync, Directory.pickDirectoryAsync) and the legacy API " +
      "(expo-file-system/legacy, which resolves to the real package).",
  },
  "expo-font": {
    module: "./font.ts",
    pinned: "57.0.2",
    status: "partial",
    omitted: ["renderToImageAsync"],
    notes: "The CSS Font Loading API (FontFace + document.fonts).",
  },
  "expo-glass-effect": {
    module: "./glass-effect.ts",
    pinned: "57.0.1",
    status: "partial",
    notes: "Liquid Glass is native iOS 26 only: isGlassEffectAPIAvailable() and " +
      "isLiquidGlassAvailable() are false, and GlassView is a CSS backdrop-filter frost.",
  },
  "expo-haptics": {
    module: "./haptics.ts",
    pinned: "57.0.2",
    status: "full",
    notes: "Soft/Rigid play as light/heavy; Android haptic constants play the nearest kind.",
  },
  "expo-image": {
    module: "./image.ts",
    pinned: "57.0.3",
    status: "partial",
    omitted: ["useImage", "ImageRef"],
    notes: "react-native-web's Image (or <img>) with contentFit; no placeholders, transitions " +
      "or blurhash; the cache calls resolve true.",
  },
  "expo-image-manipulator": {
    module: "./image-manipulator.ts",
    pinned: "57.0.17",
    status: "partial",
    omitted: ["useImageManipulator", "ImageManipulator"],
    notes: "manipulateAsync on a canvas; the result uri is a blob: URL.",
  },
  "expo-image-picker": {
    module: "./image-picker.ts",
    pinned: "57.0.14",
    status: "partial",
    omitted: [
      "VideoExportPreset",
      "UIImagePickerControllerQualityType",
      "UIImagePickerPresentationStyle",
      "UIImagePickerPreferredAssetRepresentationMode",
    ],
    notes: "One image per pick, no crop editor, no video. The picker asks for access itself, " +
      "so the permission calls report granted.",
  },
  "expo-keep-awake": {
    module: "./keep-awake.ts",
    pinned: "57.0.2",
    status: "full",
    notes: "The release listener is never called: the web wake lock is re-acquired on its own.",
  },
  "expo-linking": {
    module: "./linking.ts",
    pinned: "57.0.8",
    status: "partial",
    notes: "createURL builds <scheme>://… in the native shell and an origin URL on the web; " +
      "openURL takes http(s)/mailto/tel only; openSettings and sendIntent reject.",
  },
  "expo-network": {
    module: "./network.ts",
    pinned: "57.0.1",
    status: "partial",
    notes: "getIpAddressAsync is 0.0.0.0 and isAirplaneModeEnabledAsync false (not observable " +
      "from a web view).",
  },
  "expo-notifications": {
    module: "./notifications.ts",
    pinned: "57.0.15",
    status: "partial",
    omitted: [
      "getExpoPushTokenAsync",
      "scheduleNotificationAsync",
      "cancelScheduledNotificationAsync",
      "cancelAllScheduledNotificationsAsync",
      "getAllScheduledNotificationsAsync",
      "getNextTriggerDateAsync",
      "getNotificationCategoriesAsync",
      "setNotificationCategoryAsync",
      "deleteNotificationCategoryAsync",
      "getNotificationChannelGroupsAsync",
      "getNotificationChannelGroupAsync",
      "setNotificationChannelGroupAsync",
      "deleteNotificationChannelGroupAsync",
      "subscribeToTopicAsync",
      "unsubscribeFromTopicAsync",
      "registerTaskAsync",
      "unregisterTaskAsync",
      "BackgroundNotificationTaskResult",
      "setAutoServerRegistrationEnabledAsync",
      "NotificationTimeoutError",
      "AndroidAudioUsage",
      "AndroidAudioContentType",
      "IosAlertStyle",
      "IosAllowsPreviews",
    ],
    notes: "Remote push over @capacitor/push-notifications (APNs/FCM device tokens). " +
      "getExpoPushTokenAsync needs Expo's push service; send through APNs/FCM with the device " +
      "token instead. No local scheduling, categories, topics or background tasks. The " +
      "handler is called, but presentation follows the plugin's presentationOptions.",
  },
  "expo-paste-input": {
    module: "./paste-input.ts",
    pinned: "0.1.15",
    status: "partial",
    notes: "onPaste from the DOM paste event (text, or images as blob: URLs).",
  },
  "expo-quick-actions": {
    module: "./quick-actions.ts",
    pinned: "6.0.2",
    status: "partial",
    notes: "`initial` is always undefined: the cold-start action reaches the first " +
      "addListener subscriber instead.",
  },
  "expo-secure-store": {
    module: "./secure-store.ts",
    pinned: "57.0.2",
    status: "partial",
    omitted: ["getItem", "setItem"],
    notes: "The sync getItem/setItem run over JSI in Expo; the Capacitor bridge is async. " +
      "Keychain/Keystore natively; on the web an IndexedDB store that is NOT secret. " +
      "Biometric and accessibility options are ignored.",
  },
  "expo-sharing": {
    module: "./sharing.ts",
    pinned: "57.0.17",
    status: "partial",
    notes: "shareAsync shares web links and (through the Web Share API) files; incoming " +
      "shares need a native share extension, so the payload lists are always empty.",
  },
  "expo-sqlite": {
    module: "./sqlite.ts",
    pinned: "57.0.2",
    status: "partial",
    omitted: [
      "openDatabaseSync",
      "deleteDatabaseSync",
      "deserializeDatabaseAsync",
      "deserializeDatabaseSync",
      "backupDatabaseAsync",
      "backupDatabaseSync",
      "addDatabaseChangeListener",
      "importDatabaseFromAssetAsync",
      "SQLiteSession",
    ],
    notes: "The async API (openDatabaseAsync, execAsync, runAsync, getFirstAsync, " +
      "getAllAsync, getEachAsync, prepareAsync, withTransactionAsync, " +
      "withExclusiveTransactionAsync, the sql tag, SQLiteProvider) over denext/mobile's " +
      "openSqlite: @capacitor-community/sqlite in the Capacitor shell (`denext mobile add " +
      "sqlite`), and on the web the app's own @sqlite.org/sqlite-wasm in a worker, persisted " +
      "to OPFS through the opfs-sahpool VFS (no cross-origin isolation needed; in memory " +
      "where OPFS is unavailable). The sync API runs over JSI in Expo and is not provided " +
      "(the *Sync methods included), nor are sessions, extensions, serializeAsync, libSQL " +
      "sync or the kv-store / localStorage entry points.",
  },
  "expo-splash-screen": {
    module: "./splash-screen.ts",
    pinned: "57.0.8",
    status: "full",
    notes: "Hold the native splash with the Capacitor plugin's launchAutoHide: false.",
  },
  "expo-symbols": {
    module: "./symbols.ts",
    pinned: "57.0.2",
    status: "stub",
    notes: "SF Symbols / Material Symbols are native-only: SymbolView renders its fallback, " +
      "or an empty box of its size.",
  },
  "expo-updates": {
    module: "./updates.ts",
    pinned: "57.0.19",
    status: "partial",
    omitted: [
      "setUpdateURLAndRequestHeadersOverride",
      "setUpdateRequestHeadersOverride",
      "showReloadScreen",
      "hideReloadScreen",
      "addUpdatesStateChangeListener",
      "latestContext",
      "emitTestStateChangeEvent",
      "resetLatestContext",
      "UpdateInfoType",
      "UpdatesLogEntryCode",
      "UpdatesLogEntryLevel",
    ],
    notes: "Maps to denext's OTA (prepareUiUpdate/applyUiUpdate) with the Expo config's " +
      "updates.url as the server; update metadata (updateId, channel, manifest, log) is empty.",
  },
  "expo-video": {
    module: "./video.ts",
    pinned: "57.0.3",
    status: "partial",
    omitted: ["VideoAirPlayButton"],
    notes: "An HTMLVideoElement player; no thumbnails, Picture in Picture, subtitles or cache.",
  },
  "expo-web-browser": {
    module: "./web-browser.ts",
    pinned: "57.0.2",
    status: "partial",
    notes: "openBrowserAsync → openExternal (reports opened, no dismissal); " +
      "openAuthSessionAsync → openAuthSession; maybeCompleteAuthSession → completeAuthSession. " +
      "The Custom Tabs warm-up calls do nothing.",
  },
  "expo-widgets": {
    module: "./widgets.ts",
    pinned: "57.0.15",
    status: "partial",
    notes: "Over denext/mobile's widgets and Live Activities (`denext mobile add widget` / " +
      '`live-activity`): the UI is the generated SwiftUI, not the "widget" layout function, ' +
      "which is never rendered. updateSnapshot → setWidgetData, reload → reloadWidgets; " +
      "updateTimeline stores the entry that applies now (later entries are not scheduled). " +
      "LiveActivityFactory.start → startLiveActivity with push (retried without), returning " +
      "at once (getId() is empty until ActivityKit has started it); getInstances refreshes " +
      "from ActivityKit in the background; push and push-to-start token listeners are live. " +
      "The start url and stale dates are ignored, addUserInteractionListener never fires, and " +
      "widgetsDirectory is empty. On the web the updates do nothing and start throws.",
  },
};
