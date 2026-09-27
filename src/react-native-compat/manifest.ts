/**
 * The community React Native packages React Native mode (`reactNative` in
 * `denext.config.ts`) resolves to denext implementations: which package each entry stands in
 * for, what implements it, the version its API was matched against, how complete it is and
 * what it leaves out.
 *
 * Every entry is on by default; `reactNative: { aliases: { "<package>": false } }` resolves
 * that package normally again. A package not listed here always resolves normally.
 * `scripts/parity/native` checks each runtime stand-in's exports against the pinned package.
 * Pure data: no imports, nothing runs.
 *
 * @module
 */

/** How an aliased package is provided. */
export type CommunityAliasKind =
  /**
   * The specifiers resolve to a prebuilt runtime module,
   * `denext/react-native-compat/<module name>` (`src/react-native-compat/<module>`).
   */
  | "runtime"
  /**
   * A generated module re-exports the real package and replaces its
   * `create*Navigator` with one drawn by `denext/navigation` (the package must be installed).
   */
  | "navigator"
  /** A build transform, not a module (`.svg` imports compiled to components). */
  | "transform";

/**
 * Exports generated at build time by a runtime factory called with a package the app has
 * installed: `import * as dep from "<from>"; export const { …exports } = factory(dep)`.
 */
export interface CommunityAliasFactory {
  /** The app's package passed to the factory as a namespace. */
  readonly from: string;
  /** The runtime module's factory export. */
  readonly factory: string;
  /** The names the factory's result provides (they shadow the runtime module's own). */
  readonly exports: readonly string[];
  /**
   * `true`: when `from` does not resolve, skip the factory and keep the runtime module's own
   * exports of those names (a fallback). `false`: the package is required.
   */
  readonly optional: boolean;
}

/** One aliased community package. */
export interface CommunityAlias {
  /** How it is provided. */
  readonly kind: CommunityAliasKind;
  /**
   * `runtime`: the stand-in module, relative to `src/react-native-compat` (`"./webview.ts"`).
   * `navigator`: the `denext/navigation` factory (`createNativeStackNavigatorFactory`).
   * `transform`: empty.
   */
  readonly module: string;
  /** Subpaths of the package that resolve to the same module (`["lib/module/index"]`). */
  readonly subpaths?: readonly string[];
  /** Exports generated from an installed package ({@linkcode CommunityAliasFactory}). */
  readonly generated?: CommunityAliasFactory;
  /** The package version its API was matched against. */
  readonly pinned: string;
  /**
   * `full`: the package's API, backed for real. `partial`: the commonly used API, with
   * `omitted` exports or documented differences. `stub`: loads, and does little or nothing.
   */
  readonly status: "full" | "partial" | "stub";
  /** What implements it, for the docs table (`"denext/mobile secureStore + biometrics"`). */
  readonly implementation: string;
  /**
   * The `denext mobile add` capabilities its native half needs in the Capacitor shell (`denext
   * migrate --from expo` suggests them).
   */
  readonly capabilities?: readonly string[];
  /** Runtime exports deliberately not provided (`Name.member` names a static or member). */
  readonly omitted?: readonly string[];
  /** The differences that matter. */
  readonly notes?: string;
}

/**
 * Every community package React Native mode aliases, by package name.
 */
export const COMMUNITY_ALIASES: Readonly<Record<string, CommunityAlias>> = {
  "@react-navigation/native-stack": {
    kind: "navigator",
    module: "createNativeStackNavigatorFactory",
    pinned: "7.19.2",
    status: "full",
    implementation: "denext/navigation StackView",
    notes: "createNativeStackNavigator draws React Navigation's stack router with " +
      "denext/navigation's StackView: kept screens, platform push/pop animations, the iOS edge " +
      "swipe, Android predictive back, the header, and modal / formSheet / transparentModal " +
      "presentations with sheet detents. Every other export is the real package's.",
  },
  "@react-navigation/bottom-tabs": {
    kind: "navigator",
    module: "createBottomTabNavigatorFactory",
    pinned: "7.19.2",
    status: "full",
    implementation: "denext/navigation TabsView",
    notes: "createBottomTabNavigator draws React Navigation's tab router with " +
      "denext/navigation's TabsView: visited tabs stay mounted, tabBarIcon / tabBarLabel / " +
      "tabBarBadge, lazy / popToTopOnBlur / unmountOnBlur, and a second press pops the nested " +
      "stack then scrolls to the top. Every other export is the real package's.",
  },
  "@react-navigation/drawer": {
    kind: "runtime",
    module: "./drawer.ts",
    generated: {
      from: "@react-navigation/native",
      factory: "drawerNavigatorExports",
      exports: ["createDrawerNavigator"],
      optional: false,
    },
    pinned: "7.14.2",
    status: "partial",
    implementation: "denext Drawer over React Navigation's DrawerRouter",
    notes:
      "createDrawerNavigator keeps React Navigation's drawer router and actions; the view is " +
      "denext's Drawer, not react-native-drawer-layout. drawerType front / back / slide / " +
      "permanent, drawerPosition, drawerStyle, overlayColor / overlayStyle, swipeEnabled / " +
      "swipeEdgeWidth / swipeMinDistance (an edge swipe opens it, a drag closes it), Escape and " +
      "Android back close it, and a closed panel is inert. Visited screens stay mounted, " +
      "hidden. Each screen gets a header with DrawerToggleButton unless headerShown is false. " +
      "useDrawerProgress returns { value } 0..1 that re-renders, not a Reanimated SharedValue. " +
      "Ignored: configureGestureHandler, drawerHideStatusBarOnOpen / drawerStatusBarAnimation, " +
      "popToTopOnBlur.",
  },

  "react-native-keyboard-controller": {
    kind: "runtime",
    module: "./keyboard-controller.ts",
    generated: {
      from: "react-native-reanimated",
      factory: "reanimatedKeyboardExports",
      exports: ["useReanimatedKeyboardAnimation", "useAnimatedKeyboard"],
      optional: true,
    },
    pinned: "1.22.5",
    status: "partial",
    implementation:
      "denext/mobile keyboard (useKeyboard, KeyboardAvoidingView, KeyboardStickyView)",
    capabilities: ["keyboard"],
    notes: "KeyboardAvoidingView / KeyboardStickyView are denext/mobile's: they move only by the " +
      "part of the keyboard that covers the page; translate-with-padding pads; automaticOffset " +
      "is ignored. KeyboardAwareScrollView scrolls the focused input bottomOffset px above the " +
      "keyboard and pads its content by the covered height plus extraKeyboardSpace; " +
      "KeyboardChatScrollView is the same view. KeyboardToolbar is a bar riding on the keyboard " +
      "with previous / next (the page's inputs in document order) and Done; its button / icon / " +
      "blur props are ignored. KeyboardController.dismiss / setFocusTo / isVisible / state " +
      "work; setInputMode / setDefaultMode / preload / setTranslucent do nothing. " +
      "KeyboardEvents fire will/did show/hide. useKeyboardHandler runs on the JS thread and " +
      "steps onMove through the animation when its duration is known (the iOS shell); " +
      "onInteractive never fires. useKeyboardAnimation returns Animated.Values. " +
      "useReanimatedKeyboardAnimation / useAnimatedKeyboard are Reanimated shared values when " +
      "the app has react-native-reanimated, else { value } holders that do not re-render. " +
      "useFocusedInputHandler follows input / selectionchange events (selection x/y are 0); " +
      "FocusedInputEvents / WindowDimensionsEvents never fire. OverKeyboardView is a fixed " +
      "full-screen layer; KeyboardExtender is a bar on the keyboard; KeyboardEffects renders " +
      "its children. A React Native transform array in the avoiding / sticky views' style is " +
      "not converted.",
  },

  "react-native-safe-area-context": {
    kind: "transform",
    module: "",
    pinned: "5.10.0",
    status: "full",
    implementation: "denext/mobile useSafeAreaInsets (the package's web provider replaced)",
    notes: "The package stays; its web provider (NativeSafeAreaProvider.web) is replaced by " +
      "denext's, which reports the shell's insets through useSafeAreaInsets (not CSS env() " +
      "alone, which is wrong on Android WebView < 140). SafeAreaProvider, SafeAreaView, " +
      "useSafeAreaInsets and useSafeAreaFrame are the package's own and follow it. React " +
      "Native mode's shell viewport carries viewport-fit=cover.",
  },

  "@react-native-community/datetimepicker": {
    kind: "runtime",
    module: "./datetimepicker.ts",
    pinned: "9.2.1",
    status: "partial",
    implementation: "<input type=date|time|datetime-local>; a dialog in the Android shell",
    notes: "DateTimePicker renders an inline input; countdown edits a time. Each edit calls " +
      "onChange({ type: 'set' }, date) and onValueChange. In the Android shell, mounting it " +
      "opens a dialog as on Android: OK / Cancel / the neutral button call onChange with set / " +
      "dismissed / neutralButtonPressed, plus onDismiss / onNeutralButtonPress. " +
      "DateTimePickerAndroid.open / dismiss drive that dialog on every platform. minimumDate / " +
      "maximumDate become min / max (values are clamped), minuteInterval becomes step, " +
      "timeZoneOffsetInMinutes edits in that offset, and accentColor / textColor / themeVariant " +
      "style the input. display, locale, timeZoneName, is24Hour, firstDayOfWeek and the " +
      "Material options are ignored.",
  },

  "react-native-date-picker": {
    kind: "runtime",
    module: "./date-picker.ts",
    pinned: "5.0.13",
    status: "partial",
    implementation: "<input type=date|time|datetime-local>, or a modal dialog",
    notes:
      "Inline, DatePicker renders an input (datetime by default) and calls onDateChange on each " +
      "edit. With modal it shows a dialog while open is true: confirm calls onConfirm(date); " +
      "cancel, Escape or a backdrop tap calls onCancel(). title (null hides it), confirmText, " +
      "cancelText and theme apply. minimumDate / maximumDate / minuteInterval / " +
      "timeZoneOffsetInMinutes bound the input. locale, is24hourSource, dividerColor, " +
      "buttonColor and onStateChange are ignored; there is no spinning wheel.",
  },

  "react-native-linear-gradient": {
    kind: "runtime",
    module: "./linear-gradient.ts",
    pinned: "2.8.3",
    status: "full",
    implementation: "CSS linear-gradient()",
    omitted: ["LinearGradient.setNativeProps"],
    notes:
      "A view with a CSS linear-gradient background. start / end are exact: the view measures " +
      "itself (onLayout in React Native mode, square until then) and places each stop where the " +
      "native gradient puts it. colors may be processColor numbers. useAngle + angle is a CSS " +
      "angle (0 = towards the top); angleCenter is honoured only at the centre.",
  },

  "@react-native-community/blur": {
    kind: "runtime",
    module: "./blur.ts",
    pinned: "4.4.1",
    status: "partial",
    implementation: "CSS backdrop-filter",
    notes:
      "BlurView / VibrancyView are views with a backdrop-filter blur (blurAmount 0-100, default " +
      "10) and a tint from blurType: dark* names are dark, light / xlight light, the materials " +
      "neutral. overlayColor replaces the tint, enabled={false} renders a plain view, and " +
      "reducedTransparencyFallbackColor becomes the background where backdrop-filter is " +
      "unsupported. VibrancyView adds no vibrancy effect; blurRadius / downsampleFactor / " +
      "autoUpdate are ignored.",
  },

  "react-native-webview": {
    kind: "runtime",
    module: "./webview.ts",
    pinned: "14.0.1",
    status: "partial",
    implementation: "<iframe> with a postMessage bridge",
    notes: "source { uri } loads in a frame; source { html, baseUrl } loads through srcdoc in a " +
      "sandbox without allow-same-origin (an opaque origin). " +
      "window.ReactNativeWebView.postMessage reaches onMessage, and the ref's postMessage " +
      "delivers a message event to the page. injectJavaScript / injectedJavaScript / " +
      "injectedJavaScriptBeforeContentLoaded run for inline HTML and same-origin URLs only " +
      "(skipped with a one-time warning cross-origin). javaScriptEnabled false drops " +
      "allow-scripts. goBack / goForward / stopLoading work on same-origin frames only; " +
      "canGoBack is always false. onShouldStartLoadWithRequest is never called, originWhitelist " +
      "is ignored, source headers / method / body cannot be sent, and sites that forbid framing " +
      "refuse to load.",
  },

  "react-native-pager-view": {
    kind: "runtime",
    module: "./pager-view.ts",
    pinned: "9.0.5",
    status: "partial",
    implementation: "CSS scroll-snap pager",
    notes:
      "Each child is a full-size snap page. initialPage, scrollEnabled, orientation, pageMargin " +
      "(a gap), layoutDirection rtl and keyboardDismissMode on-drag are supported; " +
      "onPageScroll, onPageSelected and onPageScrollStateChanged fire as { nativeEvent }; the " +
      "ref has setPage (smooth unless reduced motion), setPageWithoutAnimation and " +
      "setScrollEnabled. usePagerView's scroll handlers are plain callbacks, not a " +
      "native-driver Animated.event. overdrag and offscreenPageLimit are ignored; every page " +
      "stays mounted.",
  },

  "react-native-permissions": {
    kind: "runtime",
    module: "./permissions.ts",
    pinned: "5.6.2",
    status: "partial",
    implementation: "denext/mobile checkPermission / requestPermission / openAppSettings",
    capabilities: ["permissions"],
    omitted: ["PERMISSIONS.WINDOWS.* (all but the six with a web equivalent)"],
    notes: "Each PERMISSIONS string maps to a denext permission: camera, microphone, photos " +
      "(PHOTO_LIBRARY*, READ_MEDIA_*, READ_EXTERNAL_STORAGE), location, location-background, " +
      "contacts, calendar, FACE_ID (biometrics) and APP_TRACKING_TRANSPARENCY (ATT); anything " +
      "else (Bluetooth, Siri, motion, SMS, ...), another platform's permission, or a missing " +
      "plugin reads UNAVAILABLE. Prompt / denied states read DENIED, blocked BLOCKED, limited " +
      "LIMITED. Rationales are not shown. checkNotifications / requestNotifications report " +
      "all-on or empty settings. openSettings opens the app's own settings; openPhotoPicker / " +
      "openContactPicker reject. requestLocationAccuracy reports the current accuracy. " +
      "canScheduleExactAlarms is true, canUseFullScreenIntent false. Each permission also needs " +
      "its own capability (camera, geolocation, local-notifications, contacts, ...).",
  },

  "react-native-share": {
    kind: "runtime",
    module: "./share.ts",
    pinned: "12.3.1",
    status: "partial",
    implementation: "denext/mobile share",
    capabilities: ["share"],
    notes: "Share.open uses the system sheet (@capacitor/share, then navigator.share, then the " +
      'clipboard); a dismissal rejects with "User did not share" unless failOnCancel is false. ' +
      "shareSingle cannot target one app: it opens the same sheet. Only the first of urls is " +
      "shared, as a URL. filename, type, email, recipient and excludedActivityTypes are " +
      "ignored; isPackageInstalled is always false. The UI components (Overlay, Sheet, Button, " +
      "ShareSheet) are plain web versions without animation.",
  },

  "react-native-keychain": {
    kind: "runtime",
    module: "./keychain.ts",
    pinned: "10.0.0",
    status: "partial",
    implementation: "denext/mobile secureStore + authenticateBiometric",
    capabilities: ["secure-store", "biometrics"],
    notes:
      "Credentials are one JSON entry per service or server in secureStore (Keychain / Keystore " +
      "in the shell, IndexedDB on the web). BIOMETRY_* / USER_PRESENCE / DEVICE_PASSCODE access " +
      "controls put reads behind authenticateBiometric (the passcode allowed for the " +
      "*_OR_DEVICE_PASSCODE variants); a refusal resolves false. The gate is enforced in denext " +
      "code, not by the Keychain item. accessible, securityLevel, storage, accessGroup and " +
      "cloudSync are accepted and ignored; results report STORAGE_TYPE.AES_GCM_NO_AUTH; " +
      "getSecurityLevel returns null; the shared web credential calls reject.",
  },

  "react-native-haptic-feedback": {
    kind: "runtime",
    module: "./haptic-feedback.ts",
    pinned: "3.0.0",
    status: "full",
    implementation: "denext/mobile haptic",
    capabilities: ["haptics"],
    notes:
      "The 34 types play the closest of denext's 7 kinds (impacts, notifications, selection); " +
      "noHaptics plays nothing. impact's intensity picks the weight; patterns play each event " +
      "as a light or heavy tap at its time. playAHAP resolves with no effect; Android options " +
      "are ignored and getSystemHapticStatus().ringerMode is null. TouchableHaptic is React " +
      "Native's Pressable.",
  },

  "@react-native-google-signin/google-signin": {
    kind: "runtime",
    module: "./google-signin.ts",
    pinned: "16.1.5",
    status: "partial",
    implementation: "denext/mobile signInWithGoogle",
    capabilities: ["social-login"],
    notes: "The original GoogleSignin API over @capgo/capacitor-social-login: configure({ " +
      'webClientId, iosClientId, scopes }) is required, signIn resolves { type: "success" | ' +
      '"cancelled" }, and outside the shell it rejects with PLAY_SERVICES_NOT_AVAILABLE, as the ' +
      "package's web build does. The user is remembered for the session only (after a relaunch " +
      "signInSilently returns noSavedCredentialFound). There is no access token or " +
      "serverAuthCode, and photo / givenName / familyName are null. addScopes signs in again; " +
      "revokeAccess only forgets locally. GoogleSigninButton is a styled button.",
  },

  "react-native-purchases": {
    kind: "runtime",
    module: "./purchases.ts",
    pinned: "10.10.2",
    status: "partial",
    implementation: "denext/mobile purchases (@revenuecat/purchases-capacitor)",
    capabilities: ["purchases"],
    omitted: [
      "PurchasesAdTracker",
      "Purchases.adTracker",
      "Purchases.purchaseProduct",
      "Purchases.purchaseDiscountedProduct",
      "Purchases.purchaseDiscountedPackage",
      "Purchases.purchaseSubscriptionOption",
      "Purchases.getStorefront",
      "Purchases.checkTrialOrIntroductoryPriceEligibility",
      "Purchases.getPromotionalOffer",
      "Purchases.presentCodeRedemptionSheet",
      "Purchases.beginRefundRequestForActiveEntitlement",
      "Purchases.showInAppMessages",
      "Purchases.redeemWebPurchase",
      "Purchases.getVirtualCurrencies",
      "Purchases.set*ID / attribution setters",
    ],
    notes: "configure is synchronous and every other call waits for it. getOfferings, " +
      "purchasePackage, restorePurchases and getCustomerInfo go through denext/mobile; logIn, " +
      "logOut, getAppUserID, isAnonymous, getProducts, purchaseStoreProduct, syncPurchases, " +
      "invalidateCustomerInfoCache, canMakePayments, showManageSubscriptions, setLogLevel and " +
      "the attribute setters call the Capacitor plugin (a method it lacks rejects with " +
      "UnsupportedPlatformError). No web fallback, deliberately not RevenueCat Web Billing: " +
      "outside the shell every call rejects with UnsupportedPlatformError. Errors carry " +
      "PURCHASES_ERROR_CODE codes; a cancellation sets userCancelled. Customer-info listeners " +
      "fire after this module's own calls, not on native pushes. All enums have the real " +
      "values.",
  },

  "react-native-biometrics": {
    kind: "runtime",
    module: "./biometrics.ts",
    pinned: "3.0.1",
    status: "partial",
    implementation: "denext/mobile authenticateBiometric + WebCrypto keys in secureStore",
    capabilities: ["biometrics", "secure-store"],
    notes: "isSensorAvailable reports FaceID / TouchID on iOS and Biometrics on Android (with " +
      "allowDeviceCredentials a passcode counts). simplePrompt resolves { success: false } on " +
      "cancel. createKeys makes an RSA-2048 pair with WebCrypto, the private key stored as a " +
      "JWK in secureStore and publicKey as base64 SPKI; createSignature prompts, then signs " +
      "with RSASSA-PKCS1-v1_5 / SHA-256. The key is not Secure Enclave / StrongBox backed or " +
      "bound to the enrolled biometrics: the prompt is enforced in code. " +
      "ReactNativeBiometricsLegacy is included.",
  },

  "react-native-bootsplash": {
    kind: "runtime",
    module: "./bootsplash.ts",
    pinned: "7.3.3",
    status: "full",
    implementation: "denext/mobile hideSplash",
    capabilities: ["splash"],
    notes: "hide() hides the native launch screen (@capacitor/splash-screen) in the shell and " +
      "removes the web build's #bootsplash / #bootsplash-style elements (a 250 ms fade with " +
      "fade: true). isVisible() is true in the shell until hide() ran, else whether #bootsplash " +
      "is in the page. useHideAnimation returns the container / logo / brand props and calls " +
      "animate once layout and images are ready; the Android status / navigation-bar margins " +
      "and logoSizeRatio are not applied.",
  },

  "@notifee/react-native": {
    kind: "runtime",
    module: "./notifee.ts",
    pinned: "9.1.8",
    status: "partial",
    implementation: "denext/mobile local notifications",
    capabilities: ["local-notifications"],
    notes:
      "registerForegroundService is accepted but never runs its task. Local notifications over @capacitor/local-notifications: displayNotification, " +
      "createTriggerNotification (TIMESTAMP once or HOURLY / DAILY / WEEKLY repeats, INTERVAL), " +
      "cancel*, getTriggerNotificationIds / getTriggerNotifications (from the pending list), " +
      "Android channels, iOS categories, requestPermission / getNotificationSettings, " +
      "openNotificationSettings. String ids map to stable 32-bit numbers and round-trip. " +
      "onForegroundEvent gets PRESS / ACTION_PRESS (pressAction.id, input), DELIVERED and " +
      "TRIGGER_NOTIFICATION_CREATED; JS does not run while suspended, so onBackgroundEvent " +
      "observers get the same events only while no foreground observer is registered; " +
      "getInitialNotification returns the launching press once. Channel groups are not created; " +
      "displayed notifications cannot be listed or removed; the badge count is kept in memory " +
      "and applied through the Badging API where present. Every enum has the package's values.",
  },

  "@react-native-community/netinfo": {
    kind: "runtime",
    module: "./netinfo.ts",
    pinned: "12.0.1",
    status: "partial",
    implementation: "denext/mobile networkStatus / useNetworkStatus",
    capabilities: ["network"],
    notes:
      "fetch / refresh / addEventListener (current state first, then changes) / useNetInfo / " +
      "useNetInfoInstance over @capacitor/network in the shell and navigator.onLine + the " +
      "Network Information API on the web. type is wifi, cellular, none or unknown; details " +
      "keys are present but null (no SSID, strength, carrier or generation) except " +
      "isConnectionExpensive (true on cellular). isInternetReachable follows isConnected: no " +
      "reachability probe runs, so configure() is accepted and ignored.",
  },

  "react-native-device-info": {
    kind: "runtime",
    module: "./device-info.ts",
    pinned: "15.0.2",
    status: "partial",
    implementation: "denext/mobile deviceInfo + denext/expo/application",
    capabilities: ["device", "application"],
    notes:
      "Every export is present. In the shell: model / device id (the model identifier, not a " +
      "marketing name), system name and version, emulator flag, device type / isTablet, bundle " +
      "id, app name, version, build number, getUniqueId (identifierForVendor / Android ID) and " +
      "Apple's brand. Sync getters answer at once from the user agent and Expo config, then " +
      "turn native after the first native read; await an async getter first. Everywhere: the " +
      "package's web build values (battery, memory, storage estimate, user agent). hasNotch / " +
      "hasDynamicIsland are heuristics. Android build fields, carrier, IP, device name, install " +
      "times, headphones, brightness and font scale return the package's default for a platform " +
      "without them ('unknown', -1, false, []).",
  },

  "@react-native-masked-view/masked-view": {
    kind: "runtime",
    module: "./masked-view.ts",
    pinned: "0.3.2",
    status: "partial",
    implementation: "CSS mask-image / background-clip: text",
    notes: "A LinearGradient mask (expo-linear-gradient or react-native-linear-gradient) " +
      "becomes a CSS mask-image over the children, and a Text mask over a LinearGradient " +
      "becomes gradient text. Any other mask renders the children unmasked and warns once " +
      "(a web page cannot mask with an arbitrary rendered element).",
  },
  "@react-native-menu/menu": {
    kind: "runtime",
    module: "./menu.ts",
    pinned: "2.0.0",
    status: "partial",
    implementation: "denext/mobile showContextMenu",
    notes: "MenuView opens its actions through showContextMenu (the app's DenextContextMenu " +
      "plugin in the Capacitor shell, the OS menu on Deno Desktop, else an in-page menu) on a " +
      "tap, or a long press / right click with shouldOpenOnLongPress. One level deep: " +
      "displayInline sections are spliced in, submenus listed after their parent's title; " +
      "images, subtitles and title colours are not drawn.",
  },
  "nativewind": {
    kind: "transform",
    module: "",
    pinned: "4.2.7",
    status: "partial",
    implementation: "nativewind/jsx-runtime as the app's JSX runtime",
    notes: "With nativewind installed, the app's own JSX (not its packages') runs through " +
      "nativewind/jsx-runtime, as its Babel preset's jsxImportSource does, so className on " +
      "React Native components becomes react-native-web class names. The Tailwind CSS is " +
      "compiled by Tailwind 3's CLI with the nativewind preset (see the NativeWind recipe).",
  },
  "react-native-svg-transformer": {
    kind: "transform",
    module: "",
    pinned: "1.5.3",
    status: "full",
    implementation: "react-native-svg SvgXml",
    notes: "With react-native-svg and react-native-svg-transformer installed, a JS import of a " +
      ".svg file is a component rendering the file through react-native-svg's SvgXml (props " +
      "such as width, height, fill and style pass through), as Metro's transformer makes it. " +
      "CSS url() references keep the file loader. Without the transformer installed, .svg " +
      "imports stay asset URLs.",
  },
};
