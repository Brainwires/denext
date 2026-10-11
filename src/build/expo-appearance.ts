// The colours an Expo app's native launch and root view show, carried into its Capacitor shell
// so the first frames are the app's colour instead of a white WebView: what Expo's prebuild
// writes from `userInterfaceStyle`, `backgroundColor` (expo-system-ui), `splash` and the
// `expo-splash-screen` plugin (light and `dark`). Pure: the values are read by
// ./expo-app-config.ts and written by `denext migrate --from expo` (capacitor.config.ts and the
// page's background) and `denext mobile add app-config` (./mobile-expo-app-config.ts: Info.plist,
// the launch storyboard, SceneDelegate.swift, Android's colours and themes).
//
// Every colour here went through `hexColor` (`#rrggbb`), so it is safe in Swift, XML, CSS and
// JSON alike.

import type { ExpoPlatformAppearance } from "./expo-app-config.ts";

/** A colour for light appearance and, when it differs, one for dark appearance. */
export interface AppearanceColors {
  /** `#rrggbb`. */
  light: string;
  /** `#rrggbb` in dark appearance; absent when the colour does not change with it. */
  dark?: string;
}

/** One platform's launch and root-view colours, resolved. */
export interface ResolvedAppearance {
  /** The appearance the app is fixed to (`userInterfaceStyle` `light` / `dark`), if any. */
  style?: "light" | "dark";
  /** The root view: the window, the WebView and the page behind the app. */
  app?: AppearanceColors;
  /** The launch screen / native splash. */
  launch?: AppearanceColors;
}

/** `light` / `dark` as one platform shows them under `style`. */
function colors(
  light: string | undefined,
  dark: string | undefined,
  style: ResolvedAppearance["style"],
): AppearanceColors | undefined {
  if (style === "dark") {
    const only = dark ?? light;
    return only ? { light: only } : undefined;
  }
  if (!light) return undefined;
  return style === "light" || !dark || dark === light ? { light } : { light, dark };
}

/**
 * Resolve one platform's appearance: the root view takes `backgroundColor` (one colour in
 * both appearances, as expo-system-ui paints it), else the splash colours; the launch screen
 * takes the splash colours, else `backgroundColor`. A fixed `userInterfaceStyle` keeps only
 * the colour of that appearance.
 *
 * @param p What the app config sets for the platform.
 * @returns The colours (each absent when the config sets none).
 */
export function resolveAppearance(p: ExpoPlatformAppearance): ResolvedAppearance {
  const style = p.style === "light" || p.style === "dark" ? p.style : undefined;
  const app = p.background
    ? colors(p.background, undefined, style)
    : colors(p.splash, p.splashDark, style);
  const launch = colors(p.splash ?? p.background, p.splashDark, style);
  return {
    ...(style ? { style } : {}),
    ...(app ? { app } : {}),
    ...(launch ? { launch } : {}),
  };
}

/** Whether a resolved appearance has anything to write. */
export function hasAppearance(r: ResolvedAppearance): boolean {
  return Boolean(r.style || r.app || r.launch);
}

/**
 * The page's own background, painted before the app's first frame: a `<style>` for the
 * `<head>` (dark-aware through `prefers-color-scheme`, which the native shell answers from
 * the system or the fixed `UIUserInterfaceStyle`). `color-scheme` is left alone: it would
 * recolour the default text of an app whose React Native text is black in both appearances.
 *
 * @param app The root-view colours.
 * @returns The tag, or "" when there is no colour.
 */
export function pageBackgroundStyle(app: AppearanceColors | undefined): string {
  if (!app) return "";
  const dark = app.dark
    ? `@media (prefers-color-scheme: dark){html{background-color:${app.dark}}}`
    : "";
  return `<style>html{background-color:${app.light}}${dark}</style>`;
}

/**
 * The `capacitor.config.ts` keys for the shell: Capacitor's `backgroundColor` (the WebView's,
 * one colour, so only when the root view does not change with the appearance; per platform
 * when they differ) and the SplashScreen plugin held until the app's first frame
 * (`launchAutoHide: false`: React Native mode hides it after the first commit, as Expo does).
 *
 * @param ios The iOS appearance.
 * @param android The Android appearance.
 * @returns The keys to add (empty when there is nothing).
 */
export function capacitorAppearanceConfig(
  ios: ResolvedAppearance,
  android: ResolvedAppearance,
): Record<string, unknown> {
  const single = (r: ResolvedAppearance) => (r.app && !r.app.dark ? r.app.light : undefined);
  const iosColor = single(ios);
  const androidColor = single(android);
  const out: Record<string, unknown> = {};
  if (iosColor && iosColor === androidColor) out.backgroundColor = iosColor;
  else {
    if (iosColor) out.ios = { backgroundColor: iosColor };
    if (androidColor) out.android = { backgroundColor: androidColor };
  }
  if (ios.launch || android.launch) {
    const launch = ios.launch ?? android.launch!;
    out.plugins = {
      SplashScreen: {
        launchAutoHide: false,
        ...(launch.dark ? {} : { backgroundColor: launch.light }),
      },
    };
  }
  return out;
}

/** `#rrggbb` as Swift `UIColor` components. */
function swiftColor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `UIColor(red: ${r} / 255, green: ${g} / 255, blue: ${b} / 255, alpha: 1)`;
}

/** The first line of the SceneDelegate block (the marker a re-run replaces it by). */
const SCENE_BACKGROUND_BEGIN = "// denext:app-background begin";
/** The last line of the SceneDelegate block. */
const SCENE_BACKGROUND_END = "// denext:app-background end";

/**
 * The SceneDelegate lines that paint the window and the WebView with the app's background
 * (a dynamic `UIColor` when it changes with the appearance), and keep the WebView transparent
 * while it loads, so nothing white shows before the page paints.
 *
 * @param app The root-view colours.
 * @param indent The indentation of the surrounding statements.
 */
function sceneBackgroundLines(app: AppearanceColors, indent: string): string[] {
  const color = app.dark
    ? [
      `let denextBackground = UIColor { traits in`,
      `    traits.userInterfaceStyle == .dark`,
      `        ? ${swiftColor(app.dark)}`,
      `        : ${swiftColor(app.light)}`,
      `}`,
    ]
    : [`let denextBackground = ${swiftColor(app.light)}`];
  return [
    `${SCENE_BACKGROUND_BEGIN} (from the app config; \`denext mobile add app-config\`)`,
    ...color,
    "window?.backgroundColor = denextBackground",
    "if let webView = (window?.rootViewController as? CAPBridgeViewController)?.webView {",
    "    webView.isOpaque = false",
    "    webView.backgroundColor = denextBackground",
    "    webView.scrollView.backgroundColor = denextBackground",
    "}",
    SCENE_BACKGROUND_END,
  ].map((line) => indent + line);
}

/**
 * `SceneDelegate.swift` with the background block after `window?.makeKeyAndVisible()`
 * (replacing an earlier one). Null when there is no such call to follow.
 *
 * @param source The file.
 * @param app The root-view colours.
 */
export function withSceneBackground(source: string, app: AppearanceColors): string | null {
  const begin = source.indexOf(SCENE_BACKGROUND_BEGIN);
  const end = source.indexOf(SCENE_BACKGROUND_END);
  if (begin >= 0 && end > begin) {
    const lineStart = source.lastIndexOf("\n", begin) + 1;
    const indent = source.slice(lineStart, begin);
    const lineEnd = source.indexOf("\n", end);
    const after = lineEnd < 0 ? "" : source.slice(lineEnd);
    return source.slice(0, lineStart) + sceneBackgroundLines(app, indent).join("\n") + after;
  }
  const m = /^([ \t]*)window\?\.makeKeyAndVisible\(\)[ \t]*$/m.exec(source);
  if (!m) return null;
  const at = m.index + m[0].length;
  return source.slice(0, at) + "\n" + sceneBackgroundLines(app, m[1]).join("\n") +
    source.slice(at);
}

/** One `Contents.json` colour entry. */
function catalogColor(hex: string, dark: boolean): Record<string, unknown> {
  const [red, green, blue] = [1, 3, 5].map((i) => `0x${hex.slice(i, i + 2).toUpperCase()}`);
  return {
    ...(dark ? { appearances: [{ appearance: "luminosity", value: "dark" }] } : {}),
    color: { "color-space": "srgb", components: { alpha: "1.000", blue, green, red } },
    idiom: "universal",
  };
}

/**
 * An asset-catalog colour set (`<name>.colorset/Contents.json`) with a dark appearance when the
 * colour has one.
 *
 * @param c The colours.
 */
export function colorSetJson(c: AppearanceColors): string {
  const colors = [catalogColor(c.light, false), ...(c.dark ? [catalogColor(c.dark, true)] : [])];
  return JSON.stringify({ colors, info: { author: "xcode", version: 1 } }, null, 2) + "\n";
}

/** The named colour the launch storyboard is painted with. */
export const LAUNCH_COLOR_NAME = "DenextLaunchBackground";

/** The stock launch view's background: the system background colour. */
const STOCK_LAUNCH_BACKGROUND =
  /<color key="backgroundColor" systemColor="systemBackgroundColor"\/>/;

/**
 * The launch storyboard with its view painted with the asset-catalog colour
 * {@linkcode LAUNCH_COLOR_NAME} instead of the system background (the colour set holds the
 * light / dark values; the `namedColor` resource is Interface Builder's preview of it).
 * Unchanged when it already uses that colour; null when its view has another background (an
 * edited launch screen is the app's own).
 *
 * @param storyboard `LaunchScreen.storyboard`.
 * @param c The launch colours (the light one is the preview).
 */
export function withLaunchStoryboardColor(storyboard: string, c: AppearanceColors): string | null {
  const named = `<color key="backgroundColor" name="${LAUNCH_COLOR_NAME}"/>`;
  if (storyboard.includes(named)) return storyboard;
  if (!STOCK_LAUNCH_BACKGROUND.test(storyboard) || !storyboard.includes("</resources>")) {
    return null;
  }
  const [r, g, b] = [1, 3, 5].map((i) => (parseInt(c.light.slice(i, i + 2), 16) / 255).toFixed(3));
  const resource = `        <namedColor name="${LAUNCH_COLOR_NAME}">\n` +
    `            <color red="${r}" green="${g}" blue="${b}" alpha="1" colorSpace="custom" ` +
    `customColorSpace="sRGB"/>\n        </namedColor>\n`;
  const close = storyboard.lastIndexOf("</resources>");
  const lineStart = storyboard.lastIndexOf("\n", close) + 1;
  return (storyboard.slice(0, lineStart) + resource + storyboard.slice(lineStart))
    .replace(STOCK_LAUNCH_BACKGROUND, named);
}

/** Android's colour resource names the themes take. */
export const ANDROID_LAUNCH_COLOR = "denext_launch_background";
/** The root-view colour resource. */
export const ANDROID_APP_COLOR = "denext_app_background";

/**
 * `res/values/denext_background.xml` (or `values-night/` with `night`): the launch and
 * root-view colours as resources.
 *
 * @param launch The launch colour for this configuration.
 * @param app The root-view colour for this configuration.
 */
export function androidColorsXml(launch: string, app: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Written by \`denext mobile add app-config\` from the app config's colours. -->
<resources>
    <color name="${ANDROID_LAUNCH_COLOR}">${launch.toUpperCase()}</color>
    <color name="${ANDROID_APP_COLOR}">${app.toUpperCase()}</color>
</resources>
`;
}

/**
 * `styles.xml` with `<item name="<item>">` set in the style `styleName` (added before its
 * `</style>` when missing; an item already there keeps its value). Unchanged when present;
 * null when there is no such style.
 *
 * @param styles The file.
 * @param styleName The style's `name` (`AppTheme.NoActionBarLaunch`).
 * @param item The item's name (`windowSplashScreenBackground`).
 * @param value Its value (`@color/denext_launch_background`).
 */
export function withStyleItem(
  styles: string,
  styleName: string,
  item: string,
  value: string,
): string | null {
  const open = new RegExp(`<style\\s+name="${styleName.replace(/\./g, "\\.")}"[^>]*>`).exec(styles);
  if (!open) return null;
  const close = styles.indexOf("</style>", open.index);
  if (close < 0) return null;
  const body = styles.slice(open.index, close);
  if (body.includes(`<item name="${item}">`)) return styles;
  const lineStart = styles.lastIndexOf("\n", close) + 1;
  const closeIndent = styles.slice(lineStart, close);
  if (closeIndent.trim() !== "") return null;
  const line = `${closeIndent}    <item name="${item}">${value}</item>\n`;
  return styles.slice(0, lineStart) + line + styles.slice(lineStart);
}

/**
 * The image denext puts in the launch screen's `Splash.imageset` in place of Capacitor's white
 * placeholder: the launch colour alone (a `-dark` twin for dark appearance). `denext mobile
 * build` treats it as a placeholder still, and `denext mobile assets` replaces it with the logo.
 */
export const LAUNCH_SPLASH_FILE = "denext-launch.png";
