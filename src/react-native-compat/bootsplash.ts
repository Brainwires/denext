/**
 * `react-native-bootsplash` for denext's React Native mode: `hide` / `isVisible` /
 * `useHideAnimation` over `denext/mobile`'s {@linkcode hideSplash} (`@capacitor/splash-screen`
 * in the Capacitor shell, `denext mobile add splash`).
 *
 * In the shell, `hide()` hides the native launch screen; everywhere it also removes the web
 * build's `#bootsplash` element (and its `#bootsplash-style`), fading it out over 250 ms with
 * `fade: true`, as the package's own web build does. `useHideAnimation` returns the container /
 * logo / brand props for an in-app copy of the splash and calls `animate` once the layout and
 * images are ready, right after hiding the native one.
 *
 * In React Native mode `import BootSplash from "react-native-bootsplash"` resolves here.
 *
 * @example
 * ```ts
 * import BootSplash from "react-native-bootsplash";
 *
 * await BootSplash.hide({ fade: true });
 * ```
 *
 * @module
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "../runtime/hooks.ts";
import { hideSplash } from "../mobile/splash.ts";
import { isNativeShell } from "../mobile/bridge.ts";

/** Options for {@linkcode hide}. */
export type Config = {
  /** Fade the splash out (250 ms) instead of removing it at once. */
  fade?: boolean;
};

/** The manifest `react-native-bootsplash generate` writes (`bootsplash.json`). */
export type Manifest = {
  /** The background colour. */
  background: string;
  /** The background colour in dark mode. */
  darkBackground?: string;
  /** The logo's size. */
  logo: {
    /** Width in px. */
    width: number;
    /** Height in px. */
    height: number;
  };
  /** The brand image's size and bottom offset. */
  brand?: {
    /** Offset from the bottom in px. */
    bottom: number;
    /** Width in px. */
    width: number;
    /** Height in px. */
    height: number;
  };
};

/** An image source as React Native's `Image` takes it. */
export type ImageSource = unknown;

/** Options for {@linkcode useHideAnimation}. */
export type UseHideAnimationConfig = {
  /** The generated manifest. */
  manifest: Manifest;
  /** Hold the animation until `true` (default `true`). */
  ready?: boolean;
  /** The logo image. */
  logo?: ImageSource;
  /** The logo image in dark mode. */
  darkLogo?: ImageSource;
  /** The brand image. */
  brand?: ImageSource;
  /** The brand image in dark mode. */
  darkBrand?: ImageSource;
  /** Run the hide animation; called once, after the native splash is hidden. */
  animate: () => void;
  /** Android: the status bar is translucent (ignored here). */
  statusBarTranslucent?: boolean;
  /** Android: the navigation bar is translucent (ignored here). */
  navigationBarTranslucent?: boolean;
};

/** The container view's props. */
export type ContainerProps = {
  /** An absolutely positioned, centred, full-screen style. */
  style: Record<string, unknown>;
  /** Mark the layout ready. */
  onLayout: () => void;
};

/** The logo image's props (`source: -1` when there is no logo). */
export type LogoProps = {
  /** The image, or `-1`. */
  source: ImageSource;
  /** No fade (0). */
  fadeDuration?: number;
  /** `contain`. */
  resizeMode?: string;
  /** The manifest's size. */
  style?: Record<string, unknown>;
  /** Mark the image ready. */
  onLoadEnd?: () => void;
};

/** The brand image's props (`source: -1` when there is no brand image). */
export type BrandProps = LogoProps;

/** What {@linkcode useHideAnimation} returns. */
export type UseHideAnimation = {
  /** Spread on the container `View`. */
  container: ContainerProps;
  /** Spread on the logo `Image`. */
  logo: LogoProps;
  /** Spread on the brand `Image`. */
  brand: BrandProps;
};

/** Whether `hide()` has run in the native shell (the native splash cannot be queried). */
let nativeHidden = false;

/** The web build's splash element (`#bootsplash`), or null. */
function splashElement(id: string): { remove(): void; style: Record<string, string> } | null {
  const doc = (globalThis as {
    document?: { getElementById?(id: string): unknown };
  }).document;
  const node = doc?.getElementById?.(id);
  return node ? node as { remove(): void; style: Record<string, string> } : null;
}

/** Remove the web build's splash (after a 250 ms fade with `fade`). */
async function hideWebSplash(fade: boolean): Promise<void> {
  const container = splashElement("bootsplash");
  const style = splashElement("bootsplash-style");
  if (container && fade) {
    container.style.transitionProperty = "opacity";
    container.style.transitionDuration = "250ms";
    container.style.opacity = "0";
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  container?.remove();
  style?.remove();
}

/**
 * Hide the splash screen: the native launch screen in the Capacitor shell, and the web build's
 * `#bootsplash` element.
 *
 * @param config `fade: true` fades the web splash out over 250 ms.
 * @returns When it is hidden.
 */
export async function hide(config: Config = {}): Promise<void> {
  if (isNativeShell()) {
    await hideSplash();
    nativeHidden = true;
  }
  await hideWebSplash(config.fade === true);
}

/**
 * Whether a splash is still showing: the native one until {@linkcode hide} ran (in the shell),
 * else whether the web build's `#bootsplash` element is in the page.
 *
 * @returns Whether it is visible.
 */
export function isVisible(): boolean {
  if (isNativeShell() && !nativeHidden) return true;
  return splashElement("bootsplash") !== null;
}

/** Whether the page prefers a dark colour scheme. */
function darkMode(): boolean {
  const match = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  return typeof match === "function" && match("(prefers-color-scheme: dark)").matches;
}

/**
 * Props for an in-app copy of the splash screen that animates away: spread `container` on a
 * `View`, `logo` / `brand` on `Image`s. Once the layout and the images are ready (and `ready`
 * is true), the native splash is hidden and `animate` runs, once.
 *
 * @param config The manifest, images and the animation.
 * @returns The container, logo and brand props.
 */
export function useHideAnimation(config: UseHideAnimationConfig): UseHideAnimation {
  const { manifest, ready = true, animate } = config;
  const skipLogo = config.logo == null;
  const skipBrand = manifest.brand == null || config.brand == null;
  const [dark] = useState(darkMode);
  const background = themed(dark, manifest.darkBackground, manifest.background);
  const logoSrc = skipLogo ? undefined : themed(dark, config.darkLogo, config.logo);
  const brandSrc = skipBrand ? undefined : themed(dark, config.darkBrand, config.brand);
  const state = useRef({
    layout: false,
    logo: skipLogo,
    brand: skipBrand,
    ready,
    animate,
    called: false,
  });
  const maybeAnimate = useCallback(() => {
    const s = state.current;
    if (!s.layout || !s.logo || !s.brand || !s.ready || s.called) return;
    s.called = true;
    hide({ fade: false }).then(() => state.current.animate()).catch(() => {});
  }, []);
  useEffect(() => {
    state.current.animate = animate;
    state.current.ready = ready;
    maybeAnimate();
  });
  const loaded = (part: "layout" | "logo" | "brand") => () => {
    state.current[part] = true;
    maybeAnimate();
  };
  const { logo: logoSize, brand } = manifest;
  return useMemo<UseHideAnimation>(() => ({
    container: {
      style: {
        alignItems: "center",
        backgroundColor: background,
        justifyContent: "center",
        position: "absolute",
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
      },
      onLayout: loaded("layout"),
    },
    logo: splashImage(logoSrc, logoSize, loaded("logo")),
    brand: brand == null
      ? { source: -1 }
      : splashImage(brandSrc, brand, loaded("brand"), { position: "absolute", bottom: 60 }),
  }), [
    background,
    logoSrc,
    brandSrc,
    logoSize.width,
    logoSize.height,
    brand?.width,
    brand?.height,
  ]);
}

/** `darkValue` in dark mode when there is one, else `value`. */
function themed<T>(dark: boolean, darkValue: T | null | undefined, value: T): T {
  return dark && darkValue != null ? darkValue : value;
}

/** The props of a splash image (`{ source: -1 }` when there is none). */
function splashImage(
  source: unknown,
  size: { width: number; height: number },
  onLoadEnd: () => void,
  extra: Record<string, unknown> = {},
): LogoProps {
  if (source == null) return { source: -1 } as LogoProps;
  return {
    source,
    fadeDuration: 0,
    resizeMode: "contain",
    style: { ...extra, width: size.width, height: size.height },
    onLoadEnd,
  } as LogoProps;
}

/** Forget that the native splash was hidden (tests only). */
export function resetBootSplashForTesting(): void {
  nativeHidden = false;
}

/** The package's default export: `{ hide, isVisible, useHideAnimation }`. */
const BootSplash: {
  hide: typeof hide;
  isVisible: typeof isVisible;
  useHideAnimation: typeof useHideAnimation;
} = { hide, isVisible, useHideAnimation };

export default BootSplash;
