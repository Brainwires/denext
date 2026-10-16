// The native halves of `NativeViewSlot` / `useNativeViewSlot` (denext/mobile), embedded as text
// so they ship inside the JSR package: `denext mobile add native-views` writes the plugin, the
// registry of view factories and the built-in `video` factory; `denext mobile add native-map`
// adds the `map` factory (MapKit on iOS, osmdroid on Android: neither needs an API key).
//
// - iOS (`ios/App/App/`): `DenextNativeViewsPlugin.swift` (the `DenextNativeViewFactory`
//   protocol, the `DenextNativeViews` registry, the plugin and the layers it draws in),
//   `DenextVideoViewFactory.swift` (AVPlayerViewController) and, from native-map,
//   `DenextMapViewFactory.swift` (MKMapView). `DenextBridgeViewController` registers the plugin.
// - Android (`dev/denext/nativeviews/`): the same pieces in Java (the factory interface, its
//   context, the registry, the plugin, VideoView), and `DenextOsmMapFactory.java` from
//   native-map. `MainActivity` registers the plugin.
//
// Placement. `embed` (iOS): the view is added to the native scroll view WebKit backs the slot's
// `overflow: scroll` element with (found by its content being `embedMarker` px taller than its
// box), so the compositor moves, clips and transforms it with the page. `under`: in a layer
// behind the WebView (made transparent); a router above the WebView hands touches over a slot's
// visible part to the view. `over`: in that router layer, above the WebView. `under` and `over`
// hosts are moved to the frames the page sends, clipped to the slot's visible part.
//
// Edit these as source in native-templates/native-views.ts:
// they are compiled only in an app (build-checked with xcodebuild and
// Gradle against Capacitor 8). Every escaped backslash there is a Swift key path. Every file is
// written through `renderNativeViewsTemplate` (a marker line on top); bump
// NATIVE_VIEWS_TEMPLATE_VERSION when the templates change.
//
// The template texts ship packed: native-templates/native-views.ts (the readable source, not published)
// is packed with the others into native-templates.packed.ts by `deno task gen:native-templates`.

import { markedTemplateIntact, renderMarkedTemplate } from "./native-template-marker.ts";
import { NATIVE_TEMPLATES } from "./native-templates.packed.ts";

/**
 * The generation of the templates, stamped into every file the installer writes.
 * Generation 2: the Android plugin honours `scrollPassthrough`; the bump keeps an older denext
 * from rewriting that plugin back to one where every touch on a view stays the view's.
 * Generation 3: the iOS "__debug" logging and "__frame" geometry commands are compiled into
 * Debug builds only.
 */
export const NATIVE_VIEWS_TEMPLATE_VERSION = 3;

/**
 * A template as the installer writes it: a first line
 * `// denext-native-views-template: <NATIVE_VIEWS_TEMPLATE_VERSION> sha256=<hex>`, then the
 * template.
 *
 * @param template The template text.
 * @returns The file content.
 */
export function renderNativeViewsTemplate(template: string): Promise<string> {
  return renderMarkedTemplate("native-views", NATIVE_VIEWS_TEMPLATE_VERSION, template);
}

/**
 * Whether `text` is an unedited native-views template: its marker line matches its body.
 *
 * @param text A file's content.
 * @returns `true` when the file carries an intact marker.
 */
export async function isPristineNativeViewsTemplate(text: string): Promise<boolean> {
  return await markedTemplateIntact("native-views", text) === true;
}

/** Swift sources `native-views` writes to `ios/App/App/`, keyed by file name. */
export const NATIVE_VIEWS_IOS_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.nativeViews.NATIVE_VIEWS_IOS_FILES;

/** Swift sources `native-map` writes to `ios/App/App/`, keyed by file name. */
export const NATIVE_MAP_IOS_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.nativeViews.NATIVE_MAP_IOS_FILES;

/** Java sources `native-views` writes to `dev/denext/nativeviews/`, keyed by file name. */
export const NATIVE_VIEWS_ANDROID_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.nativeViews.NATIVE_VIEWS_ANDROID_FILES;

/** Java sources `native-map` writes to `dev/denext/nativeviews/`, keyed by file name. */
export const NATIVE_MAP_ANDROID_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.nativeViews.NATIVE_MAP_ANDROID_FILES;

/** The osmdroid dependency `native-map` adds to `android/app/build.gradle`. */
export const OSMDROID_DEPENDENCY = "implementation 'org.osmdroid:osmdroid-android:6.1.20'";
