/**
 * The `denext/expo/*` shim manifest: which `expo-*` package each shim stands in for, the
 * version its API was matched against (T3 Code's `apps/mobile`, Expo SDK 58), how complete
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
  /**
   * Exports deliberately not provided. `Name.member` names a static or member of an export
   * that the shim leaves out (`Asset.byHash`).
   */
  readonly omitted?: readonly string[];
  /** Why (sync JSI APIs, native-only, …). */
  readonly notes?: string;
}

/**
 * Every `expo-*` package React Native mode aliases, by package name. A key with a subpath
 * (`expo-file-system/legacy`) is a shim for that subpath of the package; its entrypoint is
 * the package's shim name plus the subpath (`denext/expo/file-system/legacy`). A scoped
 * package is shimmed per subpath only (`@expo/ui/swift-ui` → `denext/expo/ui/swift-ui`).
 */
export const EXPO_SHIMS: Readonly<Record<string, ExpoShim>> = {
  "expo": {
    module: "./expo.ts",
    pinned: "58.0.2",
    status: "partial",
    notes: "registerRootComponent mounts through react-native-web's AppRegistry, so the app's " +
      "own index.ts is the web entry. requireNativeModule / requireOptionalNativeModule " +
      "return the Capacitor plugin of that name in the iOS/Android shell (the desktop " +
      "extension on Deno Desktop): every function returns a Promise (no synchronous " +
      "functions or constants: no JSI), events arrive through addListener. Elsewhere " +
      "requireNativeModule returns a stand-in whose functions throw only when called (a " +
      "module that asks for it at import time loads in a browser or a test; its addListener " +
      "does nothing), and requireOptionalNativeModule returns null. " +
      "requireNativeView is a denext/mobile native view slot (`denext mobile add " +
      "native-views`; the children render where the view type is not registered). " +
      "installOnUIRuntime does nothing (no worklets UI runtime). Platform is Expo's web " +
      "build's (OS \"web\"; React Native's own Platform reports the shell); uuid.v5 is " +
      "synchronous, as Expo's; CodedError / UnavailabilityError, createSnapshotFriendlyRef and " +
      "useReleasingSharedObject(WithLifecycle) behave as Expo's. " +
      "`expo/fetch` resolves here too (the platform fetch).",
  },
  "expo-apple-authentication": {
    module: "./apple-authentication.ts",
    pinned: "58.0.2",
    status: "partial",
    notes: "signInAsync over denext/mobile's signInWithApple (@capgo/capacitor-social-login, " +
      "`denext mobile add social-login`); iOS only, as in Expo. The nonce is sent to Apple as its " +
      "SHA-256 hex. The plugin signs in only: refreshAsync, signOutAsync and " +
      "getCredentialStateAsync reject, addRevokeListener never fires, and realUserStatus is " +
      "UNKNOWN. AppleAuthenticationButton is a styled <button> (black / white / outline), " +
      "rendered only in the iOS shell.",
  },
  "expo-application": {
    module: "./application.ts",
    pinned: "58.0.3",
    status: "partial",
    notes: "applicationName / applicationId / nativeApplicationVersion / nativeBuildVersion over " +
      "@capacitor/app's getInfo(); Expo reads them synchronously (JSI), so in the shell they start " +
      "from the Expo config and turn native a moment after load (live bindings; await the " +
      "denext-only applicationInfoAsync()). null on the web, as Expo's web build. getAndroidId and " +
      "getIosIdForVendorAsync over @capacitor/device's getId(); getIosApplicationReleaseTypeAsync " +
      "tells only SIMULATOR from UNKNOWN and getIosPushNotificationServiceEnvironmentAsync is null. " +
      "getInstallReferrerAsync, getInstallationTimeAsync and getLastUpdateTimeAsync reject with " +
      "ERR_UNAVAILABLE (no Capacitor plugin reports them).",
  },
  "expo-asset": {
    module: "./asset.ts",
    pinned: "58.0.10",
    status: "partial",
    omitted: ["Asset.byHash", "Asset.byUri", "Asset.fromMetadata"],
    notes: "An asset is the bundled file's URL; numeric Metro asset ids are not supported.",
  },
  "expo-audio": {
    module: "./audio.ts",
    pinned: "58.0.4",
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
      "from a Web Audio analyser; the recorder state's fileSize counts the bytes delivered; " +
      "fileName is ignored). Audio-session calls resolve without effect. Playlists and " +
      "PCM streams are not provided: the AudioPlaylist and AudioStream classes (and the " +
      "NativeAudioModule type) are stand-ins that throw when constructed.",
  },
  "expo-auth-session": {
    module: "./auth-session.ts",
    pinned: "58.0.7",
    status: "partial",
    notes: "AuthRequest (PKCE S256), useAuthRequest / useLoadedAuthRequest / " +
      "useAuthRequestResult, discovery, the token calls and their request classes " +
      "(AccessTokenRequest, RefreshTokenRequest, RevokeTokenRequest; a client secret is sent as " +
      "HTTP Basic credentials, as in Expo) over openAuthSession. loadAsync's proxy options are " +
      "not provided. The Google and Facebook presets are the providers/* entries below.",
  },
  "expo-auth-session/providers/facebook": {
    module: "./auth-session-facebook.ts",
    pinned: "58.0.7",
    status: "full",
    notes: "useAuthRequest over denext/expo/auth-session (implicit token flow by default). The " +
      "client id is picked by the platform the page runs on (iosClientId / androidClientId in " +
      "the Capacitor shell, webClientId on the web), not by Platform.OS; the shell's redirect " +
      "defaults to fb<clientId>://authorize (register it: `denext mobile add auth-session " +
      "--scheme fb<clientId>`).",
  },
  "expo-auth-session/providers/google": {
    module: "./auth-session-google.ts",
    pinned: "58.0.7",
    status: "full",
    notes:
      "useAuthRequest and useIdTokenAuthRequest over denext/expo/auth-session with PKCE. The " +
      "client id is picked by the platform the page runs on (iosClientId / androidClientId in " +
      "the Capacitor shell, webClientId on the web). In the shell the code flow runs and the " +
      "code is exchanged automatically (id_token / access_token in response.params); the " +
      "redirect defaults to <applicationId>:/oauthredirect (register the scheme with `denext " +
      "mobile add auth-session --scheme …`). On the web it asks for the token / id_token " +
      "directly. A failed exchange is an error response (Expo leaves it unhandled).",
  },
  "expo-battery": {
    module: "./battery.ts",
    pinned: "58.0.3",
    status: "partial",
    notes: "The level and charging state over @capacitor/device's getBatteryInfo() in the shell " +
      "(`denext mobile add device`; polled every 30 s while a listener is subscribed, since the " +
      "plugin reports no changes) and the Battery Status API (navigator.getBattery(), Chromium) on " +
      "the web; elsewhere -1 / UNKNOWN, as Expo's web build. Low Power Mode and battery " +
      "optimisation are not observable: both read false and the low-power listener never fires.",
  },
  "expo-blur": {
    module: "./blur.ts",
    pinned: "58.0.3",
    status: "partial",
    notes: "A CSS backdrop-filter blur with a tint overlay; system material tints map to " +
      "light/dark/default.",
  },
  "expo-build-properties": {
    module: "./build-properties.ts",
    pinned: "58.0.9",
    status: "stub",
    notes: "A config plugin for native prebuild; withBuildProperties returns the config unchanged.",
  },
  "expo-camera": {
    module: "./camera.ts",
    pinned: "58.0.7",
    status: "partial",
    notes: "CameraView previews the camera over getUserMedia; its ref's takePictureAsync takes " +
      "a canvas frame (a data: URL; quality, base64, scale, imageType, mirror, pictureRef, and " +
      "exif as the track's settings) and falls back to @capacitor/camera's system camera in the " +
      "shell without a preview; recordAsync records the preview with MediaRecorder (a blob: " +
      "URL; maxDuration, maxFileSize, mute), with toggleRecordingAsync / stopRecording. With " +
      "onBarcodeScanned it opens denext's full-screen scanner (Capacitor barcode plugin / " +
      "BarcodeDetector) instead of a preview; CameraView.launchScanner does the same and " +
      "reports to onModernBarcodeScanned (dismissScanner does nothing). onRecordingProgress " +
      "reports the recording's duration and size every progressUpdateInterval. There is no " +
      "document scanner: isDocumentScannerAvailable is false and scanDocumentAsync resolves " +
      "null, as Expo's web build. getAvailableLensesAsync lists the video inputs (deviceType " +
      '"videoinput"). The statics ' +
      "(isAvailableAsync, getAvailableVideoCodecsAsync, isModernBarcodeScannerAvailable, " +
      "ConversionTables, defaultProps) are provided. Not provided: autofocus, white balance, " +
      "picture size, videoQuality, the codec choice and EXIF written into the file. The " +
      "permission calls live on the Camera object, as in Expo; CameraNativeModule is a " +
      "stand-in that throws when constructed.",
  },
  "expo-cellular": {
    module: "./cellular.ts",
    pinned: "58.0.2",
    status: "partial",
    notes: "getCellularGenerationAsync from the Network Information API's effectiveType " +
      "(Chromium, the Android WebView; UNKNOWN elsewhere or off cellular). The carrier name, ISO " +
      "country code and mobile country / network codes are null (no WebView or browser API " +
      "reports them; iOS 16.4+ returns none natively either). The permission calls answer granted.",
  },
  "expo-checkbox": {
    module: "./checkbox.ts",
    pinned: "58.0.2",
    status: "full",
    notes:
      'A real <input type="checkbox"> (keyboard, screen readers, forms) under a drawn box in ' +
      "Expo's look: value, disabled, color, onChange (nativeEvent.value) and onValueChange.",
  },
  "expo-clipboard": {
    module: "./clipboard.ts",
    pinned: "58.0.3",
    status: "partial",
    omitted: ["getImageAsync", "setImageAsync", "ClipboardPasteButton"],
    notes: "Text only; the change listener is never called (neither platform reports changes).",
  },
  "expo-constants": {
    module: "./constants.ts",
    pinned: "58.0.9",
    status: "partial",
    omitted: [
      "default.deviceName",
      "default.systemVersion",
      "default.isDetached",
      "default.intentUri",
      "default.supportedExpoSdks",
      "default.__unsafeNoWarnManifest",
      "default.__unsafeNoWarnManifest2",
    ],
    notes: "expoConfig comes from globalThis.__DENEXT_EXPO_CONFIG__ (set it before the bundle " +
      "runs); manifest/manifest2 are null; appOwnership null, executionEnvironment standalone.",
  },
  "expo-crypto": {
    module: "./crypto.ts",
    pinned: "58.0.4",
    status: "partial",
    omitted: ["aesEncryptAsync", "aesDecryptAsync", "AESEncryptionKey", "AESSealedData"],
    notes: "WebCrypto: SHA-1/SHA-2 digests, random bytes and UUIDs. MD2/MD4/MD5 reject. " +
      "Of the AES API only the AESKeySize enum is exported; encrypt with crypto.subtle.",
  },
  "expo-dev-client": {
    module: "./dev-client.ts",
    pinned: "58.0.10",
    status: "stub",
    notes: "Expo's native dev launcher; the dev-menu calls do nothing (use `denext dev`).",
  },
  "expo-device": {
    module: "./device.ts",
    pinned: "58.0.5",
    status: "partial",
    notes: "The constants are synchronous in Expo (JSI); here they come from the user agent, " +
      "read once. Facts a web view cannot learn (brand, memory, build ids) are null.",
  },
  "expo-document-picker": {
    module: "./document-picker.ts",
    pinned: "58.0.4",
    status: "partial",
    notes: "One document per pick (`multiple` picks one); on the web the uri is a data: URL.",
  },
  "expo-file-system": {
    module: "./file-system.ts",
    pinned: "58.0.5",
    status: "partial",
    omitted: [
      "FileHandle",
      "UploadTask",
      "DownloadTask",
      "File.createDownloadTask",
      "File.pickFileAsync",
      "Directory.pickDirectoryAsync",
      "Paths.normalize",
      "Paths.parse",
      "Paths.relative",
    ],
    notes: "SDK 58's object API (File, Directory, Paths). Expo's API is synchronous (JSI); " +
      "the Capacitor bridge and OPFS are not, so sync calls act on an index kept in " +
      "localStorage and reach the files in order in the background; async readers wait for " +
      "them, and the *Sync readers answer only for files written or read this session. " +
      "File.write (async since SDK 58) settles once the write is on disk; writeSync is the " +
      "immediate form. digest() hashes with WebCrypto (MD5 rejects); canPreview() is false " +
      "and preview() rejects, as Expo's web build. Not " +
      "provided: open()/file handles, streams, watch(), upload/download tasks and pickers " +
      "(File.pickFileAsync, Directory.pickDirectoryAsync). The legacy top-level functions " +
      "(readAsStringAsync, getInfoAsync, …) are deprecation stubs in SDK 58's root and here " +
      "alike: each warns and throws Expo's migration error. The legacy API itself " +
      "(expo-file-system/legacy) is its own shim, below.",
  },
  "expo-file-system/legacy": {
    module: "./file-system-legacy.ts",
    pinned: "58.0.5",
    status: "partial",
    notes: "The pre-SDK-54 promise API (documentDirectory, cacheDirectory, getInfoAsync, " +
      "readAsStringAsync, writeAsStringAsync, deleteAsync, moveAsync, copyAsync, " +
      "makeDirectoryAsync, readDirectoryAsync, downloadAsync, uploadAsync over fetch) over the same files as the " +
      "object API. getInfoAsync never reports md5, missing parent folders are created on " +
      "write, move/copy replace the destination, and the disk-space calls report the " +
      "origin's storage quota (navigator.storage.estimate()). Native-only exports are " +
      "stand-ins that throw or reject naming denext: createDownloadResumable, " +
      "DownloadResumable, createUploadTask, UploadTask, getContentUriAsync and " +
      "the StorageAccessFramework calls (its readAsStringAsync/writeAsStringAsync/" +
      "deleteAsync/moveAsync/copyAsync aliases work).",
  },
  "expo-font": {
    module: "./font.ts",
    pinned: "58.0.5",
    status: "partial",
    omitted: ["renderToImageAsync"],
    notes: "The CSS Font Loading API (FontFace + document.fonts). SDK 58's font families " +
      "(loadAsync / useFonts with [{ fontFamily, fontDefinitions }]) register a FontFace per " +
      "weight / style, checked as Expo checks them (ERR_FONT_API), and unloadAsync's weight / " +
      "style / display options remove only the matching faces.",
  },
  "expo-gl": {
    module: "./gl.ts",
    pinned: "58.0.3",
    status: "partial",
    notes:
      "GLView is a <canvas> with a WebGL 2 context (WebGL 1 where 2 is missing) sized to its " +
      "box at the device pixel ratio, handed to onContextCreate with Expo's additions " +
      "(endFrameEXP a no-op, flushEXP, contextId, texImage2D / texSubImage2D taking an Asset); " +
      "onContextLost / onContextRestored, webglContextAttributes, msaaSamples (antialias), the " +
      "ref's takeSnapshotAsync (a blob: URL) and the createContextAsync / destroyContextAsync / " +
      "takeSnapshotAsync statics. A WebView has no GL on a worklet runtime (getWorkletContext " +
      "returns undefined, enableExperimentalWorkletSupport is ignored) and no camera textures: " +
      "createCameraTextureAsync and destroyObjectAsync reject with ERR_UNAVAILABLE. Snapshot " +
      "flip / rect / framebuffer are ignored (the whole canvas, upright).",
  },
  "expo-glass-effect": {
    module: "./glass-effect.ts",
    pinned: "58.0.3",
    status: "partial",
    notes: "Liquid Glass is native iOS 26 only: isGlassEffectAPIAvailable() and " +
      "isLiquidGlassAvailable() are false, and GlassView is a CSS backdrop-filter frost.",
  },
  "expo-haptics": {
    module: "./haptics.ts",
    pinned: "58.0.4",
    status: "partial",
    notes: "Soft/Rigid play as light/heavy; Android haptic constants play the nearest kind.",
  },
  "expo-image": {
    module: "./image.ts",
    pinned: "58.0.10",
    status: "partial",
    notes: "react-native-web's Image (or <img> layers) with contentFit / contentPosition, " +
      "BlurHash / ThumbHash sources and placeholders (decoded in JS), a cross-dissolve " +
      "transition (skipOnCacheHit honoured), blurRadius, recyclingKey and " +
      "accessibilityElementsHidden (aria-hidden). cachePolicy is best effort: disk / memory-disk " +
      "read what prefetch or writeToCacheAsync stored with the Cache API, memory what loaded " +
      "this session. The statics (prefetch, loadAsync, clearMemoryCache, clearDiskCache, " +
      "getCachePathAsync, write/readFromCacheAsync, configureCache, generateBlurhashAsync / " +
      "generateThumbhashAsync on a canvas, Image.Image) and useImage / ImageRef are provided; " +
      "configureCache's limits are not enforced. tintColor and svgVariables are ignored; the ref's " +
      "startAnimating / stopAnimating / lockResourceAsync do nothing. ImageNativeModule is a " +
      "stand-in that throws when constructed.",
  },
  "expo-image-manipulator": {
    module: "./image-manipulator.ts",
    pinned: "58.0.11",
    status: "partial",
    omitted: ["useImageManipulator", "ImageManipulator"],
    notes: "manipulateAsync on a canvas; the result uri is a blob: URL.",
  },
  "expo-image-picker": {
    module: "./image-picker.ts",
    pinned: "58.0.10",
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
    pinned: "58.0.3",
    status: "partial",
    notes: "The release listener is never called: the web wake lock is re-acquired on its own.",
  },
  "expo-linear-gradient": {
    module: "./linear-gradient.ts",
    pinned: "58.0.3",
    status: "full",
    notes: "A view with a CSS linear-gradient background, React Native mode's " +
      "react-native-linear-gradient component: start / end ({ x, y } or [x, y]) are exact (the " +
      "view measures itself), locations as given. dither (Android) is ignored. A MaskedView whose " +
      "mask is this gradient becomes a CSS mask-image.",
  },
  "expo-linking": {
    module: "./linking.ts",
    pinned: "58.0.10",
    status: "partial",
    notes: "createURL builds <scheme>://… in the native shell and an origin URL on the web; " +
      "openURL takes http(s)/mailto/tel only; unwrapDevLaunchURL is Expo's own pure function; " +
      "openSettings opens the app's settings through " +
      "denext/mobile's openAppSettings (`denext mobile add permissions`); sendIntent starts the intent in the Android shell " +
      "through the same plugin and rejects elsewhere.",
  },
  "expo-local-authentication": {
    module: "./local-authentication.ts",
    pinned: "58.0.2",
    status: "partial",
    notes: "Over denext/mobile's biometrics (@aparajita/capacitor-biometric-auth, `denext mobile " +
      "add biometrics`). No web biometrics: no hardware, and authenticateAsync fails with " +
      "not_available. cancelAuthenticate resolves without dismissing the prompt; the Android " +
      "prompt's subtitle, description, confirmation and security class are the plugin's own; " +
      "getEnrolledLevelAsync cannot tell a weak Android biometric from a strong one.",
  },
  "expo-localization": {
    module: "./localization.ts",
    pinned: "58.0.3",
    status: "full",
    notes:
      "getLocales / getCalendars / useLocales / useCalendars from Intl and navigator.languages " +
      "(the device's settings in the shell's WebView), synchronous as Expo's; the hooks re-render " +
      "on languagechange. measurementSystem is derived from the region (us / uk / metric, the OS " +
      "default) where Expo's web build reports null; the currency fields are null, as on Expo's " +
      "web build (no web API reports a region's currency).",
  },
  "expo-location": {
    module: "./location.ts",
    pinned: "58.0.10",
    status: "partial",
    omitted: [
      "getHeadingAsync",
      "watchHeadingAsync",
      "getMotionActivityPermissionsAsync",
      "requestMotionActivityPermissionsAsync",
      "useMotionActivityPermissions",
      "getMotionActivityAsync",
      "watchMotionActivityAsync",
      "startLocationUpdatesAsync",
      "stopLocationUpdatesAsync",
      "hasStartedLocationUpdatesAsync",
      "startGeofencingAsync",
      "stopGeofencingAsync",
      "hasStartedGeofencingAsync",
    ],
    notes: "Foreground location over denext/mobile's geolocation (@capacitor/geolocation, " +
      "`denext mobile add geolocation`; navigator.geolocation on the web) and its permission " +
      "API. geocodeAsync / reverseGeocodeAsync need a geocoding service a WebView lacks: they " +
      "call the geocoder passed to setGeocoder (denext only) and reject without one. Background " +
      "location and geofencing are not wired in this shim (background permission reads " +
      "denied; for background updates use denext/mobile's watchPositionInBackground, " +
      "`denext mobile add background-location`), and the compass heading and motion activity " +
      "are not provided. " +
      "installWebGeolocationPolyfill does nothing (navigator.geolocation is already there).",
  },
  "expo-mail-composer": {
    module: "./mail-composer.ts",
    pinned: "58.0.3",
    status: "partial",
    notes: "composeAsync opens the mail app with a mailto: URL through openExternal (the shell " +
      "hands it to Mail / the default mail app): recipients, cc, bcc, subject and a plain-text " +
      "body (an HTML body is sent as its text). Attachments reject with ERR_MAIL_ATTACHMENTS (a " +
      "mailto: URL cannot carry them; use expo-sharing). The status is always undetermined and " +
      "getClients() is empty, as on Expo's web build.",
  },
  "expo-maps": {
    module: "./maps.ts",
    pinned: "58.0.4",
    status: "partial",
    notes: "AppleMaps.View and GoogleMaps.View are denext/mobile's native map view (MapKit on " +
      "iOS, osmdroid on Android: `denext mobile add native-map`): cameraPosition, markers " +
      "(coordinates, title), properties.mapType, uiSettings scroll / zoom, onCameraMove, " +
      "onMarkerClick and the ref's setCameraPosition / selectMarker. Other props (polylines, " +
      "circles, user location, …) are ignored. Where the map view is not registered natively " +
      "(the web) they render a labelled placeholder and the ref methods throw; " +
      "GoogleMaps.StreetView is always a placeholder and openLookAroundAsync rejects. The enums " +
      "are real, and the location permission calls are denext/expo/location's foreground " +
      "permission. For a map on the web render Leaflet / MapLibre GL in a .web.tsx file.",
  },
  "expo-media-library": {
    module: "./media-library.ts",
    pinned: "58.0.5",
    status: "partial",
    notes: "SDK 58's class API over denext/mobile's media library (@capacitor-community/media, " +
      "`denext mobile add media-library`) and the photos permission: Asset.create saves into " +
      "the library (a browser downloads the file), Album.create / get / getAll list and make " +
      "albums, and a Query's limit / offset / album / MEDIA_TYPE filter lists the newest assets " +
      "on iOS, newest first (other filters and sort orders are ignored). An asset knows what " +
      "the listing reported (getUri is a thumbnail data: URL whatever the AssetUriVersion, plus " +
      "its size, media type, " +
      "creation time and duration); Album.getType, Album.getAlbumsMetadata and " +
      "Album.getSmartAlbums read the plugin's album type (iOS smart albums; Android albums are " +
      "regular); its other getters, deleting, moving, favouriting, " +
      "exeForMetadata and presentPermissionsPicker reject, and no media subtypes are reported. " +
      "The deprecated functions work here (Expo's throw), as in expo-media-library/legacy.",
  },
  "expo-media-library/legacy": {
    module: "./media-library-legacy.ts",
    pinned: "58.0.5",
    status: "partial",
    notes: "Expo's function API over the same calls: saveToLibraryAsync / createAssetAsync save " +
      "into the library (a browser downloads the file), getAlbumsAsync / getAlbumAsync / " +
      "createAlbumAsync, and getAssetsAsync lists the newest assets on iOS (uri is a thumbnail " +
      "data: URL; one page, hasNextPage false). Moving, deleting and favouriting assets, " +
      "getAssetInfoAsync, moments and presentPermissionsPickerAsync reject; the change listener " +
      "never fires.",
  },
  "expo-mesh-gradient": {
    module: "./mesh-gradient.ts",
    pinned: "58.0.3",
    status: "partial",
    notes: "MeshGradientView drawn with CSS: a radial gradient per mesh point (about one cell " +
      "wide; smoothsColors widens it) over the mesh's average colour, on every platform. An " +
      "approximation of SwiftUI's MeshGradient, not the same interpolation. resolution and " +
      "ignoresSafeArea are ignored; with mask the children draw over the gradient instead of " +
      "masking it.",
  },
  "expo-navigation-bar": {
    module: "./navigation-bar.ts",
    pinned: "58.0.4",
    status: "partial",
    notes: "Android's navigation bar over denext/mobile's setSystemBars (Capacitor 8's " +
      "SystemBars, `denext mobile add system-bars`): setStyle (the buttons' color; auto / " +
      "inverted follow the page's color scheme), setVisibilityAsync and the <NavigationBar> " +
      "component. The visibility is what the app last set: a swipe that reveals a hidden bar is " +
      "not reported. Outside the Android shell the calls do nothing and the bar reads hidden, as " +
      "Expo's web build.",
  },
  "expo-network": {
    module: "./network.ts",
    pinned: "58.0.3",
    status: "partial",
    notes: "getIpAddressAsync is 0.0.0.0 and isAirplaneModeEnabledAsync false (not observable " +
      "from a web view).",
  },
  "expo-notifications": {
    module: "./notifications.ts",
    pinned: "58.0.11",
    status: "partial",
    omitted: [
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
    notes: "Remote push over @capacitor/push-notifications (APNs/FCM device tokens); local " +
      "scheduling, categories and channels over @capacitor/local-notifications (`denext mobile " +
      "add local-notifications`); a content's threadIdentifier groups it (the plugin's group) " +
      'and a trigger\'s delivery "alarmClock" schedules an exact alarm (allowWhileIdle). ' +
      "getExpoPushTokenAsync rejects with " +
      "ERR_NOTIFICATIONS_NO_EXPO_PUSH_SERVICE (denext has no Expo push service): send through " +
      "APNs/FCM with getDevicePushTokenAsync's device token instead. Identifiers map to the plugin's 32-bit ids by " +
      "hash; getNextTriggerDateAsync is computed in JS; categories persist in localStorage (the " +
      "plugin cannot list them) and, on iOS, also apply to remote pushes' aps.category. No " +
      "channel groups, topics or background tasks. The handler is called, but presentation " +
      "follows the plugins' presentationOptions. setBadgeCountAsync uses the Badging API; its " +
      "web (badgin) options are ignored.",
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
  "expo-screen-capture": {
    module: "./screen-capture.ts",
    pinned: "58.0.5",
    status: "partial",
    notes: "Over denext/mobile's setPrivacyScreen (@capacitor/privacy-screen, `denext mobile " +
      "add privacy-screen`): preventScreenCaptureAsync blocks screenshots and recording on " +
      "Android (FLAG_SECURE) until every key releases it, and hides the app switcher snapshot " +
      "on iOS (iOS cannot block a screenshot); enable/disableAppSwitcherProtectionAsync blur the " +
      "snapshot. The screenshot listener never fires and the permission reads granted. Does " +
      "nothing outside the shell.",
  },
  "expo-screen-orientation": {
    module: "./screen-orientation.ts",
    pinned: "58.0.2",
    status: "partial",
    notes: "Over denext/mobile's lockOrientation / unlockOrientation / getOrientation / " +
      "onOrientationChange (@capacitor/screen-orientation, `denext mobile add " +
      "screen-orientation`; the Screen Orientation API in a browser, which usually locks only " +
      "in fullscreen). OrientationLock.OTHER / UNKNOWN and lockPlatformAsync's Android constant " +
      "are not lockable; getOrientationLockAsync reports the lock set through this module; the " +
      "iOS size classes are UNKNOWN.",
  },
  "expo-secure-store": {
    module: "./secure-store.ts",
    pinned: "58.0.2",
    status: "partial",
    omitted: ["getItem", "setItem"],
    notes: "The sync getItem/setItem run over JSI in Expo; the Capacitor bridge is async. " +
      "Keychain/Keystore natively (or the desktop keychain); on the web an IndexedDB store that " +
      "is NOT secret, so isAvailableAsync() is false there. requireAuthentication gates reads " +
      "behind denext/mobile's authenticateBiometric (`denext mobile add biometrics`): enforced " +
      "in denext's code, not by a Keychain access control (the plugin has none); without a " +
      "secret store it is refused, never stored. Accessibility options are ignored.",
  },
  "expo-sensors": {
    module: "./sensors.ts",
    pinned: "58.0.2",
    status: "partial",
    notes: "Accelerometer (g, Expo's sign), Gyroscope (rad/s) and DeviceMotion (m/s², rotation " +
      "in radians from deviceorientation, rotationRate in deg/s) from the page's devicemotion / " +
      "deviceorientation events, converted to Expo's units (its web build does not convert); " +
      "updates at most once per setUpdateInterval (default 100 ms). requestPermissionsAsync " +
      "asks for iOS motion access (call it from a tap). Magnetometer / MagnetometerUncalibrated / " +
      "LightSensor use the Generic Sensor API where the browser exposes it (not in the WebView " +
      "shells). Barometer and Pedometer have no web API: isAvailableAsync() is false, a watch " +
      "never fires and getStepCountAsync rejects with ERR_UNAVAILABLE.",
  },
  "expo-sharing": {
    module: "./sharing.ts",
    pinned: "58.0.13",
    status: "partial",
    notes: "shareAsync shares web links and (through the Web Share API) files; incoming " +
      "shares need a native share extension, so the payload lists are always empty.",
  },
  "expo-sms": {
    module: "./sms.ts",
    pinned: "58.0.2",
    status: "partial",
    notes: "In the iOS / Android shell, sendSMSAsync opens the Messages app with an sms: URL " +
      '(recipients and body; the user sends it) and resolves { result: "unknown" } (the app ' +
      "reports nothing back, as on Android). Attachments reject with ERR_SMS_ATTACHMENTS. " +
      "Outside the shell isAvailableAsync() is false and sendSMSAsync rejects with " +
      "ERR_UNAVAILABLE, as Expo's web build.",
  },
  "expo-speech": {
    module: "./speech.ts",
    pinned: "58.0.3",
    status: "partial",
    notes: "The OS speech engine in the shell through @capacitor-community/text-to-speech " +
      "(`denext mobile add text-to-speech`; required on Android, whose WebView has no " +
      "speechSynthesis): onStart / onDone / onStopped / onError / onBoundary, voices by " +
      "voiceURI; pause and resume reject with ERR_UNAVAILABLE (the plugin cannot pause). " +
      "Elsewhere (browsers, the iOS WKWebView without the plugin) the Web Speech API with every " +
      "callback and pause / resume. Utterances queue; stop() clears the queue.",
  },
  "expo-sqlite": {
    module: "./sqlite.ts",
    pinned: "58.0.8",
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
      "(the *Sync methods included, interruptSync too), nor are sessions, extensions, " +
      "serializeAsync or the kv-store / localStorage entry points.",
  },
  "expo-splash-screen": {
    module: "./splash-screen.ts",
    pinned: "58.0.4",
    status: "full",
    notes: "Hold the native splash with the Capacitor plugin's launchAutoHide: false.",
  },
  "expo-status-bar": {
    module: "./status-bar.ts",
    pinned: "58.0.3",
    status: "full",
    notes: "Over React Native mode's StatusBar: Capacitor 8's SystemBars in the native shell " +
      '(denext mobile add system-bars); "auto" / "inverted" follow the page\'s color scheme. ' +
      "Does nothing in a browser, as Expo's web build.",
  },
  "expo-store-review": {
    module: "./store-review.ts",
    pinned: "58.0.2",
    status: "full",
    notes: "requestReview over denext/mobile's requestReview (the in-app review sheet: `denext " +
      "mobile add app-review`); isAvailableAsync is true in the shell with the plugin. " +
      "storeUrl() is the Expo config's ios.appStoreUrl / android.playStoreUrl. Does nothing in " +
      "a browser, as Expo's web build.",
  },
  "expo-symbols": {
    module: "./symbols.ts",
    pinned: "58.0.3",
    status: "partial",
    notes: "SymbolView is denext/mobile's SystemIcon: the real SF Symbol in the iOS shell " +
      "(`denext mobile add system-icons`; weight, tintColor, type and palette colors apply), " +
      "the Material Symbol named by name.android (or mapped from the SF Symbol name for the " +
      "common ones) as inline SVG elsewhere, or the fallback off iOS when one is given. " +
      "animationSpec, resizeMode and scale are ignored; unstable_getMaterialSymbolSourceAsync " +
      "resolves null.",
  },
  "expo-system-ui": {
    module: "./system-ui.ts",
    pinned: "58.0.5",
    status: "full",
    notes: "The root view is the page: setBackgroundColorAsync paints <html> and <body> (what " +
      "shows behind the app in the shell: overscroll, the keyboard's gap); " +
      "getBackgroundColorAsync returns the colour last set (#RRGGBB for a hex colour or a " +
      "processColor number), or null.",
  },
  "expo-tracking-transparency": {
    module: "./tracking-transparency.ts",
    pinned: "58.0.2",
    status: "full",
    notes: "App Tracking Transparency over denext/mobile's getTrackingStatus / " +
      "requestTrackingPermission (`denext mobile add tracking`: " +
      "capacitor-plugin-app-tracking-transparency 3, which also writes " +
      "NSUserTrackingUsageDescription). In the iOS shell " +
      "without the plugin the permission is undetermined and cannot be asked (isAvailable() is " +
      "false); on Android and the web it reports granted, as Expo's builds do. " +
      "getAdvertisingId() is always null (the plugin does not read the IDFA).",
  },
  "expo-updates": {
    module: "./updates.ts",
    pinned: "58.0.13",
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
      "updates.url as the server; update metadata (updateId, channel, manifest, log) is " +
      "empty. ExpoUpdatesModule is a stand-in that throws when constructed.",
  },
  "expo-video": {
    module: "./video.ts",
    pinned: "58.0.6",
    status: "partial",
    omitted: ["VideoAirPlayButton"],
    notes: "Where denext/mobile's native video view is registered (`denext mobile add " +
      "native-views`: AVPlayer with the system controls on iOS, so Picture in Picture and " +
      "AirPlay come from AVKit's controls), VideoView shows the source there and the player's " +
      "play / pause / currentTime / loop / muted drive it; a vertical swipe on it scrolls the " +
      "page. Elsewhere, and for a file in the app's own storage, an HTMLVideoElement player. " +
      "volume and playbackRate apply to the HTMLVideoElement only; no thumbnails, subtitles or " +
      "cache; isPictureInPictureSupported() is false. The Android playerBuilderOptions are " +
      "accepted and ignored.",
  },
  "expo-video-thumbnails": {
    module: "./video-thumbnails.ts",
    pinned: "58.0.2",
    status: "full",
    notes: "getThumbnailAsync seeks a <video> to time, draws the frame on a <canvas> and " +
      "returns a JPEG blob: URL with its size (Expo's web build throws). The video must be " +
      "readable by the page (same-origin, blob: / data:, the shell's own files, or CORS); " +
      "headers are sent by fetching the video first. Formats are the WebView's.",
  },
  "expo-web-browser": {
    module: "./web-browser.ts",
    pinned: "58.0.4",
    status: "partial",
    notes: "openBrowserAsync → openExternal (reports opened, no dismissal); " +
      "openAuthSessionAsync → openAuthSession; maybeCompleteAuthSession → completeAuthSession, " +
      "only in the auth-session popup and on the session's redirect URL (unless " +
      "skipRedirectCheck), as Expo checks. " +
      "The Custom Tabs warm-up calls do nothing.",
  },
  "expo-widgets": {
    module: "./widgets.ts",
    pinned: "58.0.11",
    status: "partial",
    notes: "Over denext/mobile's widgets and Live Activities (`denext mobile add widget` / " +
      '`live-activity`): the UI is the generated SwiftUI, not the "widget" layout function, ' +
      "which is never rendered. updateSnapshot → setWidgetData, reload → reloadWidgets; " +
      "updateTimeline stores the entry that applies now (later entries are not scheduled). " +
      "LiveActivityFactory.start → startLiveActivity with push (retried without), returning " +
      "at once (getId() is empty until ActivityKit has started it); getInstances refreshes " +
      "from ActivityKit in the background; push and push-to-start token listeners are live. " +
      "The start url and stale dates are ignored, addUserInteractionListener never fires, and " +
      "widgetsDirectory is empty. createWidget's initialProps are what getTimeline reports " +
      "before the first update (not written natively, so a stored snapshot is kept); " +
      "setConfigurationParameterEnum does nothing (a configurable widget's options are built " +
      "into the extension). On the web the updates do nothing and start throws.",
  },
  "@expo/ui/community/datetime-picker": {
    module: "./ui-community-datetime-picker.ts",
    pinned: "58.0.11",
    status: "partial",
    notes: "React Native mode's DateTimePicker (also @react-native-community/datetimepicker's): " +
      "an <input type=date|time|datetime-local> with onChange / onValueChange / onDismiss, " +
      "minimumDate / maximumDate and disabled; display, locale and the Android dialog " +
      "presentation are accepted and use the browser's own picker (@expo/ui's own web build " +
      "renders nothing).",
  },
  "@expo/ui/community/masked-view": {
    module: "./ui-community-masked-view.ts",
    pinned: "58.0.11",
    status: "partial",
    notes: "React Native mode's MaskedView (also @react-native-masked-view/masked-view's): a " +
      "LinearGradient mask becomes a CSS mask-image and a Text mask over a LinearGradient " +
      "becomes gradient text; any other mask renders the children unmasked and warns once " +
      "(@expo/ui's own web build never masks).",
  },
  "@expo/ui/community/menu": {
    module: "./ui-community-menu.ts",
    pinned: "58.0.11",
    status: "partial",
    notes: "React Native mode's MenuView (also @react-native-menu/menu's): the actions open " +
      "through denext/mobile's showContextMenu on a tap, or a long press / right click with " +
      "shouldOpenOnLongPress, and the choice reaches onPressAction (@expo/ui's own web build " +
      "never fires one). One level deep: submenus are listed after their parent's title; " +
      "images are not drawn.",
  },
  "@expo/ui/community/pager-view": {
    module: "./ui-community-pager-view.ts",
    pinned: "58.0.11",
    status: "partial",
    notes: "React Native mode's PagerView (also react-native-pager-view's): a CSS scroll-snap " +
      "pager with its events and ref methods (@expo/ui's own web build throws when it " +
      "renders).",
  },
  "@expo/ui/jetpack-compose": {
    module: "./ui-jetpack-compose.ts",
    pinned: "58.0.11",
    status: "stub",
    notes: "Jetpack Compose views are native Android UI: every component renders its children " +
      "with web layout (Column / Row as flex boxes, Text as text, the buttons as a <button> " +
      "calling onPress) and warns once; importing never throws. useNativeState is a plain " +
      "holder, getMaterialColors / useMaterialColors return {}, isDynamicColorAvailable is " +
      "false. A data-driven list (LazyItems / LazyColumn.Items with data, keyExtractor and a " +
      "render function as children) renders a row per item. Give the screen a .web.tsx layout " +
      "for a real web UI.",
  },
  "@expo/ui/jetpack-compose/modifiers": {
    module: "./ui-jetpack-compose-modifiers.ts",
    pinned: "58.0.11",
    status: "stub",
    notes: "Each modifier returns an inert { $type, $args } config that nothing applies.",
  },
  "@expo/ui/swift-ui": {
    module: "./ui-swift-ui.ts",
    pinned: "58.0.11",
    status: "stub",
    notes: "SwiftUI views are native iOS UI: every component renders its children with web " +
      "layout (VStack / HStack as flex boxes, Text as text, Button as a <button> calling " +
      "onPress) and warns once; importing never throws. withAnimation runs its body at once; " +
      "useNativeState is a plain holder. A data-driven list (List.ForEach / ListForEach, " +
      "LazyVStack.ForEach, LazyHStack.ForEach with data, keyExtractor and a render function as " +
      "children) renders a row per item. Give the screen a .web.tsx layout for a real web UI.",
  },
  "@expo/ui/swift-ui/modifiers": {
    module: "./ui-swift-ui-modifiers.ts",
    pinned: "58.0.11",
    status: "stub",
    notes: "Each modifier returns an inert { $type, $args } config that nothing applies " +
      "(Animation presets included).",
  },
};
