/**
 * The platform theme of `denext/navigation`: iOS bars that blur the content scrolling under
 * them (and, for iOS 26, a floating Liquid Glass-style tab bar and glass header buttons), the
 * large title that collapses as the screen scrolls, the system fonts, and Android's Material 3
 * top app bar and navigation bar — all following light/dark and an accent color.
 *
 * It is a stylesheet keyed off attributes the views already render (`data-dnx-theme`,
 * `data-dnx-look`, `data-dnx-scrolled`), added once through the CSSOM (CSP-safe, like the View
 * Transition rules) and only on the client: the markup is the same with or without it, so a
 * server render and the hydrating client always agree. `theme="auto"` (the default) applies it
 * only inside the Capacitor shell, which the client marks on `<html data-dnx-shell>`.
 *
 * The views read every themed value through a `var(--dnx-…, <plain value>)`, so without the
 * stylesheet (`theme="plain"`, the web, SSR) they look exactly as before.
 *
 * @module
 */

import { useLayoutEffect } from "../runtime/hooks.ts";
import { nativePlatform } from "../mobile/bridge.ts";
import { ensureStyles } from "./animation.ts";
import type { NavigationPlatform } from "./types.ts";

/**
 * Which look the navigators take:
 *
 * - `"auto"` (the default): the platform theme inside the Capacitor iOS/Android shell, the
 *   plain look everywhere else.
 * - `"platform"`: the platform theme everywhere (the web too).
 * - `"plain"`: the plain look everywhere (system colors, opaque bars).
 */
export type NavigationTheme = "auto" | "platform" | "plain";

/**
 * The iOS bar material of the platform theme: `"glass"` (iOS 26's Liquid Glass, approximated:
 * a floating translucent tab bar and glass header buttons; the default) or `"blur"` (the
 * iOS 7–18 translucent bars, edge to edge).
 */
export type IosBarMaterial = "glass" | "blur";

/** The theme props every navigator takes. */
export interface NavigationThemeProps {
  /** The look (default `"auto"`: the platform theme inside the native shell). */
  readonly theme?: NavigationTheme;
  /** iOS: the bar material of the platform theme (default `"glass"`). */
  readonly material?: IosBarMaterial;
  /** The tint of back buttons, active tabs and the Material indicator (any CSS color). */
  readonly accentColor?: string;
}

/** A themed element's selector: its own `data-dnx-theme` turned on, for one platform look. */
function scope(look: NavigationPlatform): string {
  return `:is([data-dnx-theme="platform"],:root[data-dnx-shell] [data-dnx-theme="auto"])` +
    `[data-dnx-look="${look}"]`;
}

/** The palette custom properties, light then dark, for one look. */
const PALETTE: Readonly<Record<NavigationPlatform, readonly [string, string]>> = {
  ios: [
    "--dnx-accent:#007aff;--dnx-bg:#fff;--dnx-label:#000;--dnx-label-2:rgba(60,60,67,.6);" +
    "--dnx-separator:rgba(60,60,67,.29);--dnx-bar:rgba(249,249,249,.8);" +
    "--dnx-fill:rgba(120,120,128,.16);--dnx-glass:rgba(255,255,255,.58);" +
    "--dnx-glass-rim:rgba(255,255,255,.75);--dnx-glass-light:inset 0 1px 0 rgba(255,255,255,.7);" +
    "--dnx-glass-shadow:0 8px 28px rgba(0,0,0,.12),0 1px 3px rgba(0,0,0,.08)",
    "--dnx-accent:#0a84ff;--dnx-bg:#000;--dnx-label:#fff;--dnx-label-2:rgba(235,235,245,.6);" +
    "--dnx-separator:rgba(84,84,88,.65);--dnx-bar:rgba(22,22,24,.8);" +
    "--dnx-fill:rgba(120,120,128,.32);--dnx-glass:rgba(44,44,48,.55);" +
    "--dnx-glass-rim:rgba(255,255,255,.16);--dnx-glass-light:inset 0 1px 0 rgba(255,255,255,.14);" +
    "--dnx-glass-shadow:0 8px 28px rgba(0,0,0,.45)",
  ],
  // Material 3's baseline scheme (primary, surface, surface-container, on-surface, …).
  android: [
    "--dnx-accent:#6750a4;--dnx-bg:#fef7ff;--dnx-m3-container:#f3edf7;--dnx-label:#1d1b20;" +
    "--dnx-label-2:#49454f",
    "--dnx-accent:#d0bcff;--dnx-bg:#141218;--dnx-m3-container:#211f26;--dnx-label:#e6e0e9;" +
    "--dnx-label-2:#cac4d0",
  ],
};

/** The palette rules: light by default, dark by the OS or an app's `data-theme` / `.dark`. */
function paletteCss(look: NavigationPlatform): string {
  const s = scope(look);
  const [light, dark] = PALETTE[look];
  return `${s}{${light}}` +
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]):not(.light) ${s}{${dark}}}` +
    `:root[data-theme="dark"] ${s},:root.dark ${s}{${dark}}`;
}

/** iOS: system font, blurred bars over the content, the scroll-edge header, glass. */
function iosCss(): string {
  const s = scope("ios");
  const glass = `${s}[data-dnx-material="glass"]`;
  const header = `${s} [data-dnx-header="ios"]`;
  const scrolled = `${s} [data-dnx-scrolled] > [data-dnx-header="ios"]`;
  const blur = "-webkit-backdrop-filter:saturate(180%) blur(20px);" +
    "backdrop-filter:saturate(180%) blur(20px)";
  const glassFill = "background:var(--dnx-glass);-webkit-backdrop-filter:blur(14px) " +
    "saturate(190%);backdrop-filter:blur(14px) saturate(190%);box-shadow:inset 0 0 0 .5px " +
    "var(--dnx-glass-rim),var(--dnx-glass-light),var(--dnx-glass-shadow)";
  const bottomInset = "max(10px,calc(env(safe-area-inset-bottom,0px) - 10px))";
  return [
    `${s}{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;` +
    `-webkit-font-smoothing:antialiased;color:var(--dnx-label);--dnx-screen-bg:var(--dnx-bg);` +
    `--dnx-header-fg:var(--dnx-label);--dnx-header-tint:var(--dnx-accent);` +
    `--dnx-tab-active:var(--dnx-accent);--dnx-tab-inactive:var(--dnx-label-2);` +
    `--dnx-tabbar-bg:var(--dnx-bar)}`,
    // The header floats over the screen's scroller, transparent at the top (the scroll edge),
    // the blurred material with a hairline once content scrolls under it.
    `${header}{--dnx-header-position:absolute;top:0;left:0;right:0;` +
    `--dnx-header-bg:transparent;--dnx-header-border:.5px solid transparent;` +
    `transition:background-color .2s linear,border-color .2s linear}`,
    `${header} + [data-dnx-screen-body]{padding-top:calc(var(--dnx-header-height,44px) + ` +
    `var(--dnx-header-inset,env(safe-area-inset-top,0px)));scroll-padding-top:` +
    `calc(var(--dnx-header-height,44px) + var(--dnx-header-inset,env(safe-area-inset-top,0px)))}`,
    `${scrolled}{--dnx-header-bg:var(--dnx-bar);--dnx-header-border:.5px solid ` +
    `var(--dnx-separator);${blur}}`,
    `${s} [data-dnx-back]:active,${s} [data-dnx-header-right] :is(a,button):active{opacity:.35}`,
    `${s} [data-dnx-large-title]{letter-spacing:.012em;transform-origin:0 50%}`,
    // Glass (iOS 26): no hairline; a soft scroll-edge blur that fades out downwards, and the
    // back button and trailing items as glass capsules.
    `${glass} [data-dnx-scrolled] > [data-dnx-header="ios"]{--dnx-header-bg:transparent;` +
    `--dnx-header-border:.5px solid transparent;-webkit-backdrop-filter:none;backdrop-filter:none}`,
    `${glass} [data-dnx-header="ios"]::before{content:"";position:absolute;inset:0 0 -18px 0;` +
    `z-index:-1;pointer-events:none;opacity:0;transition:opacity .2s linear;` +
    `background:linear-gradient(var(--dnx-bg),transparent);-webkit-backdrop-filter:blur(8px);` +
    `backdrop-filter:blur(8px);-webkit-mask-image:linear-gradient(#000 55%,transparent);` +
    `mask-image:linear-gradient(#000 55%,transparent)}`,
    `${glass} [data-dnx-scrolled] > [data-dnx-header="ios"]::before{opacity:1}`,
    `${glass} [data-dnx-header="ios"] [data-dnx-back]{--dnx-back-padding:0 14px 0 10px;` +
    `min-height:40px;border-radius:20px;${glassFill}}`,
    // The tab bar: blurred and edge to edge over the panels, or (glass) a floating capsule.
    `${s}[data-dnx-tabs="bottom"]{position:relative;` +
    `--dnx-tabbar-overlap:calc(49px + env(safe-area-inset-bottom,0px))}`,
    `${s}[data-dnx-tabs="bottom"] > [data-dnx-tabbar="ios"]{position:absolute;left:0;right:0;` +
    `bottom:0;z-index:2;--dnx-tabbar-border-top:.5px solid var(--dnx-separator);${blur}}`,
    `${glass}[data-dnx-tabs="bottom"]{--dnx-tabbar-overlap:calc(62px + ${bottomInset} + 12px)}`,
    `${glass}[data-dnx-tabs="bottom"] > [data-dnx-tabbar="ios"]{left:16px;right:16px;` +
    `bottom:${bottomInset};max-width:520px;margin-inline:auto;padding:4px;border-radius:31px;` +
    `--dnx-tabbar-pad-bottom:4px;--dnx-tabbar-border-top:none;${glassFill}}`,
    `${glass} [data-dnx-tabbar="ios"] [data-dnx-tab]{--dnx-tab-min-height:54px;` +
    `border-radius:27px;transition:background-color .2s ease}`,
    `${glass} [data-dnx-tabbar="ios"] [data-dnx-tab][aria-selected="true"]{` +
    `--dnx-tab-bg:var(--dnx-fill)}`,
    // Content scrolls under the bar: the panels (and the stacks inside them) pad for it.
    `${s} [data-dnx-tabpanel]:not(:has([data-dnx-stack])){padding-bottom:` +
    `var(--dnx-tabbar-overlap,0px);box-sizing:border-box}`,
    `${s} [data-dnx-screen-body]{padding-bottom:` +
    `var(--dnx-tabbar-overlap,0px);scroll-padding-bottom:var(--dnx-tabbar-overlap,0px)}`,
    // Reduce Transparency: opaque bars.
    `@media (prefers-reduced-transparency: reduce){${s}{--dnx-bar:var(--dnx-bg);` +
    `--dnx-glass:var(--dnx-bg)}}`,
  ].join("\n");
}

/** Android: Material 3's top app bar and navigation bar. */
function androidCss(): string {
  const s = scope("android");
  const indicator = "color-mix(in srgb,var(--dnx-accent) 24%,var(--dnx-m3-container))";
  return [
    `${s}{font-family:Roboto,"Google Sans",system-ui,sans-serif;color:var(--dnx-label);` +
    `--dnx-screen-bg:var(--dnx-bg);--dnx-header-fg:var(--dnx-label);` +
    `--dnx-header-tint:var(--dnx-label);--dnx-tab-active:var(--dnx-label);` +
    `--dnx-tab-inactive:var(--dnx-label-2);--dnx-tab-indicator:${indicator};` +
    `--dnx-tabbar-bg:var(--dnx-m3-container)}`,
    // Small top app bar: 64dp, title-large, surface; surface-container once content scrolls.
    `${s} [data-dnx-header="android"]{--dnx-header-height:64px;--dnx-header-bg:var(--dnx-bg);` +
    `--dnx-header-shadow:none;--dnx-header-title-size:22px;--dnx-header-title-weight:400;` +
    `transition:background-color .2s linear}`,
    `${s} [data-dnx-scrolled] > [data-dnx-header="android"]{--dnx-header-bg:` +
    `var(--dnx-m3-container)}`,
    `${s} [data-dnx-header="android"] [data-dnx-back]:active{background:rgba(127,127,127,.16)}`,
    // Navigation bar: 80dp, a 64×32 indicator pill behind the active icon, label-medium.
    `${s} [data-dnx-tabbar="android"]{padding-top:12px;--dnx-tabbar-pad-bottom:` +
    `calc(16px + env(safe-area-inset-bottom,0px))}`,
    `${s} [data-dnx-tabbar="android"] [data-dnx-tab]{--dnx-tab-min-height:52px;` +
    `justify-content:flex-start;letter-spacing:.04em}`,
    `${s} [data-dnx-tab-icon]{transition:background-color .2s cubic-bezier(.2,0,0,1)}`,
  ].join("\n");
}

/** Controls the bars share on both looks: no tap flash, no text selection, no callout. */
function sharedCss(): string {
  const s = `:is([data-dnx-theme="platform"],:root[data-dnx-shell] [data-dnx-theme="auto"])`;
  return `${s} :is([data-dnx-tab],[data-dnx-back]){-webkit-tap-highlight-color:transparent;` +
    `-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}`;
}

/**
 * The whole platform-theme stylesheet (exported for tests and for apps that ship it in their
 * own CSS, e.g. to have it before the first client render).
 *
 * @returns The CSS text.
 */
export function platformThemeCss(): string {
  return [paletteCss("ios"), paletteCss("android"), iosCss(), androidCss(), sharedCss()].join(
    "\n",
  );
}

/** Whether `theme` shows the platform look on this client. */
function themeActive(theme: NavigationTheme): boolean {
  if (theme === "platform") return true;
  return theme === "auto" && nativePlatform() !== "web";
}

/**
 * The client half of the theme: add the stylesheet once (before paint) when this client shows
 * the platform look, and mark `<html data-dnx-shell="ios|android">` inside the native shell so
 * the `"auto"` rules apply. A no-op for `"plain"` and during SSR.
 */
export function useNavigationTheme(theme: NavigationTheme): void {
  useLayoutEffect(() => {
    if (!themeActive(theme)) return;
    ensureStyles("theme:platform", platformThemeCss);
    const platform = nativePlatform();
    const root = (globalThis as { document?: { documentElement?: Element } }).document
      ?.documentElement;
    if (platform !== "web" && root?.getAttribute?.("data-dnx-shell") !== platform) {
      root?.setAttribute?.("data-dnx-shell", platform);
    }
  }, [theme]);
}

/**
 * The attributes and style a themed navigator's container carries.
 *
 * @param props The navigator's theme props.
 * @param look The platform look it draws.
 * @returns Attributes to spread onto the container, and style entries to merge into its style.
 */
export function themeAttributes(
  props: NavigationThemeProps,
  look: NavigationPlatform,
): { attrs: Record<string, string>; style: Record<string, string> } {
  return {
    attrs: {
      "data-dnx-theme": props.theme ?? "auto",
      "data-dnx-look": look,
      "data-dnx-material": props.material ?? "glass",
    },
    style: props.accentColor ? { "--dnx-accent": props.accentColor } : {},
  };
}
