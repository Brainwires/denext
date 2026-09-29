/**
 * The React Native mode overlay: denext's implementations of the React Native APIs that
 * react-native-web mocks, leaves unfinished, or backs only with browser APIs a web view lacks.
 * React Native mode (`reactNative` in `denext.config.ts`) keeps the app's pinned
 * react-native-web and replaces each of these modules inside it with the export of the same
 * name here, so `import { Keyboard } from "react-native"`, react-native-web's own internals
 * (its `FlatList` builds a `RefreshControl`, its `ScrollView` reads `Platform`) and deep
 * `react-native/Libraries/…` imports all get denext's; every other name still comes from
 * react-native-web. The React Native names react-native-web does not export at all
 * (`PermissionsAndroid`, `ToastAndroid`, `ActionSheetIOS`, `DevSettings`, `PlatformColor`,
 * `DynamicColorIOS`, `RootTagContext`, and the `useAnimatedValue` family through
 * {@linkcode createAnimatedHook}) are added to react-native-web's entry from here.
 *
 * The components take react-native-web's `View` from the replaced module
 * ({@linkcode createKeyboardAvoidingView}, {@linkcode createRefreshControl}), so this module
 * never imports react-native-web itself. It is a prebuilt runtime entry
 * (`denext/react-native`), sharing the app's one denext instance, and is not a public
 * entrypoint: apps import `react-native`.
 *
 * @module
 */

export { AccessibilityInfo } from "./accessibility-info.ts";
export { ActionSheetIOS } from "./action-sheet-ios.ts";
export { Alert } from "./alert.ts";
export { AppState } from "./app-state.ts";
export { BackHandler } from "./back-handler.ts";
export { createAnimatedHook, DevSettings, RootTagContext } from "./core-extras.ts";
export { Clipboard, Share, Vibration } from "./device-apis.ts";
export {
  AppTheme,
  ColorWithSystemEffectMacOS,
  createDesktopView,
  createFlyout,
  createGlyph,
  createPopup,
  DynamicColorMacOS,
  EventPhase,
  HandledEventPhase,
  supportKeyboard,
} from "./desktop.ts";
export { I18nManager } from "./i18n-manager.ts";
export { reactNativeFontScale, withFontScaleRatio, withFontScaling } from "./font-scaling.ts";
export { pickImageScale, resolveAssetSource, withImageStatics } from "./image-scale.ts";
export { createKeyboardAvoidingView, Keyboard } from "./keyboard.ts";
export { createInputAccessoryView } from "./input-accessory-view.ts";
export { Linking } from "./linking.ts";
export { PermissionsAndroid } from "./permissions-android.ts";
export { Platform } from "./platform.ts";
export { DynamicColorIOS, PlatformColor } from "./platform-color.ts";
export { createRefreshControl } from "./refresh-control.ts";
export { createFlatList } from "./lists/flat-list.ts";
export { createSectionList } from "./lists/section-list.ts";
export { createVirtualizedList } from "./lists/virtualized.ts";
export { createNativeSafeAreaProvider, createSafeAreaView } from "./safe-area.ts";
export { withScrollSnap } from "./scroll-snap.ts";
export { StatusBar } from "./status-bar.ts";
export { ToastAndroid } from "./toast-android.ts";
export { createTouchableNativeFeedback } from "./touchable-native-feedback.ts";
export { DrawerLayoutAndroid, Settings } from "./android-compat.ts";
export {
  createNativeEventEmitter,
  createNativeModules,
  dispatchViewManagerCommand,
  nativeHostComponent,
  turboModule,
  withViewManagerCommands,
} from "./native-modules.ts";
