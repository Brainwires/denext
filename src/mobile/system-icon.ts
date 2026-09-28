/**
 * `<SystemIcon>` for `denext/mobile`: the platform's own icon set. Inside the iOS shell with
 * `denext mobile add system-icons` it is the real SF Symbol, rendered natively
 * (`UIImage(systemName:)` at the requested weight, scale and pixel density) and cached on both
 * sides; everywhere else — Android, the web, desktop, SSR — a Material Symbol drawn as inline
 * SVG. SF Symbols are licensed by Apple for Apple platforms only, so denext ships none of their
 * artwork: iOS draws them itself.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { useLayoutEffect, useRef, useState } from "../runtime/hooks.ts";
import { nativePlatform } from "./bridge.ts";
import { nativePlugin } from "./plugin.ts";
import { builtinMaterialSymbols } from "./material-symbols.ts";

/** An SF Symbol weight (`UIImage.SymbolWeight`). */
export type SystemIconWeight =
  | "ultralight"
  | "thin"
  | "light"
  | "regular"
  | "medium"
  | "semibold"
  | "bold"
  | "heavy"
  | "black";

/**
 * How an SF Symbol is colored: `"monochrome"` (the default: the icon is a mask filled with the
 * CSS `color`, so it follows the text color, dark mode and `:hover`), `"hierarchical"` (layers
 * in opacities of `color`), `"palette"` (`colors`, one per layer) or `"multicolor"` (Apple's
 * own colors).
 */
export type SystemIconMode = "monochrome" | "hierarchical" | "palette" | "multicolor";

/** Props of {@linkcode SystemIcon}. */
export interface SystemIconProps {
  /** The SF Symbol name (`"square.and.arrow.up"`, `"house.fill"`). */
  readonly name: string;
  /**
   * The Material Symbol drawn off iOS (`"share"`, `"home-fill"`). Default: mapped from `name`
   * for the common symbols (`house` → `home`, a `.fill` suffix → the `-fill` variant).
   */
  readonly android?: string;
  /** The icon box's size in CSS px (default `24`). */
  readonly size?: number;
  /** The SF Symbol weight (default `"regular"`). */
  readonly weight?: SystemIconWeight;
  /** The SF Symbol scale relative to its point size (default `"medium"`). */
  readonly scale?: "small" | "medium" | "large";
  /** How the SF Symbol is colored (default `"monochrome"`). */
  readonly mode?: SystemIconMode;
  /** `"palette"` mode's layer colors (CSS hex or `rgb()`). */
  readonly colors?: readonly string[];
  /** The icon color (default: the inherited text color). */
  readonly color?: string;
  /** An accessible name; without one the icon is decorative (`aria-hidden`). */
  readonly label?: string;
  /** A class for the icon box. */
  readonly className?: string;
  /** Extra style for the icon box. */
  readonly style?: Readonly<Record<string, string | number | undefined>>;
}

/** A natively rendered SF Symbol. */
interface RenderedSymbol {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

/** The JS side of the `DenextSystemIcon` plugin (`denext mobile add system-icons`). */
interface SystemIconPlugin {
  render(options: {
    name: string;
    pointSize: number;
    weight: SystemIconWeight;
    scale: "small" | "medium" | "large";
    pixelScale: number;
    mode: SystemIconMode;
    colors: string[];
  }): Promise<RenderedSymbol>;
}

/** The SF Symbol stems that map to a Material Symbol of another name. */
const SF_TO_MATERIAL: Readonly<Record<string, string>> = {
  house: "home",
  magnifyingglass: "search",
  gearshape: "settings",
  gear: "settings",
  "person.crop.circle": "person",
  bell: "notifications",
  heart: "favorite",
  "square.and.arrow.up": "share",
  trash: "delete",
  plus: "add",
  xmark: "close",
  checkmark: "check",
  "chevron.left": "chevron_left",
  "chevron.right": "chevron_right",
  "chevron.down": "keyboard_arrow_down",
  "chevron.up": "keyboard_arrow_up",
  ellipsis: "more_horiz",
  "ellipsis.vertical": "more_vert",
  pencil: "edit",
  "square.and.pencil": "edit",
  "doc.on.doc": "content_copy",
  paperplane: "send",
  envelope: "mail",
  camera: "photo_camera",
  photo: "image",
  "lock.open": "lock_open",
  "arrow.clockwise": "refresh",
  "info.circle": "info",
  "exclamationmark.triangle": "warning",
  "exclamationmark.circle": "error",
  calendar: "calendar_today",
  clock: "schedule",
  mappin: "location_on",
  "mappin.and.ellipse": "location_on",
  location: "location_on",
  cart: "shopping_cart",
  "bubble.left": "chat_bubble",
  message: "chat_bubble",
  phone: "call",
  "line.3.horizontal": "menu",
  "slider.horizontal.3": "tune",
  "arrow.down.circle": "download",
  "square.and.arrow.down": "download",
  "icloud.and.arrow.up": "upload",
  eye: "visibility",
  "eye.slash": "visibility_off",
  archivebox: "archive",
  tray: "inbox",
  "arrow.left": "arrow_back",
  "arrow.right": "arrow_forward",
  "arrow.up": "arrow_upward",
  "arrow.down": "arrow_downward",
  "arrow.up.right.square": "open_in_new",
  "arrowshape.turn.up.left": "reply",
  "rectangle.portrait.and.arrow.right": "logout",
  "line.3.horizontal.decrease": "filter_list",
  "arrow.up.arrow.down": "sort",
  play: "play_arrow",
};

/** Apps' own Material Symbols (`registerSystemIcons`), created on first registration. */
let registered: Map<string, string> | null = null;

/** The path data for Material Symbol `name`, if it is registered or built in. */
function materialPath(name: string): string | undefined {
  return registered?.get(name) ?? builtinMaterialSymbols().get(name);
}

/**
 * The Material Symbol an SF Symbol name maps to: the `.fill` suffix becomes the `-fill`
 * variant (when there is one), and trailing components are dropped until a stem is known
 * (`heart.circle.fill` → `favorite-fill`).
 *
 * @param sfName The SF Symbol name.
 * @returns A Material Symbol name, or `undefined` when none is known.
 */
export function materialNameFor(sfName: string): string | undefined {
  const fill = sfName.endsWith(".fill");
  let parts = (fill ? sfName.slice(0, -5) : sfName).split(".");
  while (parts.length > 0) {
    const stem = parts.join(".");
    const base = SF_TO_MATERIAL[stem] ?? stem;
    if (fill && materialPath(`${base}-fill`)) return `${base}-fill`;
    if (materialPath(base)) return base;
    parts = parts.slice(0, -1);
  }
  return undefined;
}

/**
 * Add Material Symbols `SystemIcon` can draw off iOS: name → the `d` of the symbol's path in
 * its 960-unit grid (`viewBox="0 -960 960 960"`, as `@material-symbols/svg-*` ships them). A
 * registered name replaces a built-in one.
 *
 * @param icons Name → path data.
 * @example
 * ```ts
 * import { registerSystemIcons } from "denext/mobile";
 * registerSystemIcons({ rocket_launch: "M…Z" }); // from @material-symbols/svg-400/outlined
 * ```
 */
export function registerSystemIcons(icons: Readonly<Record<string, string>>): void {
  registered ??= new Map();
  for (const [name, d] of Object.entries(icons)) registered.set(name, d);
}

/** Rendered SF Symbols by request, created on first use. */
let cache: Map<string, RenderedSymbol | Promise<RenderedSymbol | null> | null> | null = null;

/** The native renderer: only inside the iOS shell with the plugin installed. */
function symbolPlugin(): SystemIconPlugin | undefined {
  if (nativePlatform() !== "ios") return undefined;
  return nativePlugin<SystemIconPlugin>("DenextSystemIcon", ["render"]);
}

/** What one native render request is. */
interface SymbolRequest {
  readonly name: string;
  readonly size: number;
  readonly weight: SystemIconWeight;
  readonly scale: "small" | "medium" | "large";
  readonly mode: SystemIconMode;
  readonly colors: readonly string[];
}

/** The cache key of a request (at this device's pixel ratio). */
function requestKey(req: SymbolRequest, pixelScale: number): string {
  return [req.name, req.size, req.weight, req.scale, req.mode, req.colors.join(","), pixelScale]
    .join("|");
}

/** The device pixel ratio (whole, 1–3). */
function pixelRatio(): number {
  const dpr = (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 2;
  return Math.min(3, Math.max(1, Math.round(dpr)));
}

/**
 * Render `req` natively (once per key: concurrent and later requests share it). Resolves
 * `null` when the symbol does not exist on this iOS or the render failed.
 */
function renderSymbol(
  plugin: SystemIconPlugin,
  req: SymbolRequest,
): RenderedSymbol | Promise<RenderedSymbol | null> | null {
  cache ??= new Map();
  const pixelScale = pixelRatio();
  const key = requestKey(req, pixelScale);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const store = cache;
  // SF Symbols' point size is a font size; ~0.8 of the box keeps the glyph (with its natural
  // side bearings) inside a `size`-px square, like UIKit's default symbol configuration.
  const pending = plugin.render({
    name: req.name,
    pointSize: Math.round(req.size * 0.8 * 10) / 10,
    weight: req.weight,
    scale: req.scale,
    pixelScale,
    mode: req.mode,
    colors: [...req.colors],
  }).then(
    (r) => {
      const ok = typeof r?.dataUrl === "string" && r.dataUrl.startsWith("data:image/") ? r : null;
      store.set(key, ok);
      return ok;
    },
    () => {
      store.set(key, null);
      return null;
    },
  );
  store.set(key, pending);
  return pending;
}

/**
 * Warm the native SF Symbol cache (in the iOS shell; a no-op elsewhere), so the icons a first
 * screen shows draw without waiting for the bridge. Call it early (before the first render).
 *
 * @param names The SF Symbol names, or requests with `size` / `weight` / `scale`.
 * @returns A promise that settles once every render finished.
 */
export async function preloadSystemIcons(
  names: ReadonlyArray<string | Pick<SystemIconProps, "name" | "size" | "weight" | "scale">>,
): Promise<void> {
  const plugin = symbolPlugin();
  if (!plugin) return;
  await Promise.all(names.map((n) => {
    const p = typeof n === "string" ? { name: n } : n;
    return renderSymbol(plugin, {
      name: p.name,
      size: p.size ?? 24,
      weight: p.weight ?? "regular",
      scale: p.scale ?? "medium",
      mode: "monochrome",
      colors: [],
    });
  }));
}

/** A CSS color as `#rrggbb[aa]` for the native side (hex and `rgb()`/`rgba()` are read). */
export function hexColor(color: string): string | undefined {
  const c = color.trim();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c)) {
    const hex = c.length === 4 ? "#" + [...c.slice(1)].map((x) => x + x).join("") : c;
    return hex.toLowerCase();
  }
  const m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i
    .exec(c);
  if (!m) return undefined;
  const byte = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  const alpha = m[4] === undefined
    ? ""
    : byte((m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4])) * 255);
  return "#" + byte(+m[1]) + byte(+m[2]) + byte(+m[3]) + (alpha === "ff" ? "" : alpha);
}

/** The colors a non-monochrome render needs: `colors`, else the box's resolved text color. */
function symbolColors(props: SystemIconProps, el: Element | null): string[] {
  const mode = props.mode ?? "monochrome";
  if (mode === "monochrome" || mode === "multicolor") return [];
  if (mode === "palette" && props.colors?.length) {
    return props.colors.map(hexColor).filter((c): c is string => c !== undefined);
  }
  const cs = (globalThis as { getComputedStyle?: (e: Element) => { color?: string } })
    .getComputedStyle;
  const color = props.color ?? (el && cs ? cs(el)?.color : undefined);
  const hex = color ? hexColor(color) : undefined;
  return hex ? [hex] : [];
}

/** The Material Symbol fallback as inline SVG (or nothing, when the name is unknown). */
function materialSvg(name: string | undefined, size: number): VNode | null {
  const d = name ? materialPath(name) : undefined;
  if (!d) return null;
  return h(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 -960 960 960",
      fill: "currentColor",
      "aria-hidden": "true",
      focusable: "false",
      style: { display: "block" },
    },
    h("path", { d }),
  );
}

/** The state of the native path: not taken, waiting for the bridge, drawn, or failed. */
type NativeState =
  | { readonly kind: "none" }
  | { readonly kind: "pending" }
  | { readonly kind: "ready"; readonly symbol: RenderedSymbol };

/** The state that draws the Material Symbol (shared, so resetting to it is a no-op render). */
const NO_SYMBOL: NativeState = { kind: "none" };

/** The native SF Symbol for `props`, driven from a layout effect (so SSR and hydration match). */
function useNativeSymbol(props: SystemIconProps, size: number): {
  state: NativeState;
  ref: (el: Element | null) => void;
} {
  const [state, setState] = useState<NativeState>(NO_SYMBOL);
  const elRef = useRef<Element | null>(null);
  const mode = props.mode ?? "monochrome";
  const colorKey = `${props.color ?? ""}|${props.colors?.join(",") ?? ""}`;
  useLayoutEffect(() => {
    const plugin = symbolPlugin();
    if (!plugin) return setState(NO_SYMBOL);
    const result = renderSymbol(plugin, {
      name: props.name,
      size,
      weight: props.weight ?? "regular",
      scale: props.scale ?? "medium",
      mode,
      colors: symbolColors(props, elRef.current),
    });
    if (result === null) return setState(NO_SYMBOL);
    if (!(result instanceof Promise)) return setState({ kind: "ready", symbol: result });
    let live = true;
    setState({ kind: "pending" });
    result.then((symbol) => {
      if (live) setState(symbol ? { kind: "ready", symbol } : NO_SYMBOL);
    });
    return () => {
      live = false;
    };
  }, [props.name, size, props.weight, props.scale, mode, colorKey]);
  return { state, ref: (el) => void (elRef.current = el) };
}

/** The box style of a native SF Symbol: a `currentColor` mask, or (colored modes) the image. */
function nativeStyle(symbol: RenderedSymbol, mode: SystemIconMode): Record<string, string> {
  const url = `url("${symbol.dataUrl}")`;
  if (mode !== "monochrome") {
    return {
      backgroundImage: url,
      backgroundRepeat: "no-repeat",
      backgroundPosition: "center",
      backgroundSize: "contain",
    };
  }
  return {
    backgroundColor: "currentColor",
    WebkitMaskImage: url,
    maskImage: url,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskPosition: "center",
    maskPosition: "center",
    WebkitMaskSize: "contain",
    maskSize: "contain",
  };
}

/**
 * The platform's icon: the SF Symbol `name` inside the iOS shell (natively rendered, tinted by
 * the CSS `color`), the Material Symbol `android` (or the one mapped from `name`) everywhere
 * else. SSR draws the Material Symbol; the iOS shell swaps in the SF Symbol before paint once
 * it is cached, and hides the box for the one bridge round trip of a first render.
 *
 * @example
 * ```tsx
 * "use client";
 * import { SystemIcon } from "denext/mobile";
 *
 * export function ShareButton({ onShare }: { onShare: () => void }) {
 *   return (
 *     <button type="button" onClick={onShare} aria-label="Share">
 *       <SystemIcon name="square.and.arrow.up" android="share" size={22} weight="medium" />
 *     </button>
 *   );
 * }
 * ```
 */
export function SystemIcon(props: SystemIconProps): VNode {
  const size = props.size ?? 24;
  const mode = props.mode ?? "monochrome";
  const { state, ref } = useNativeSymbol(props, size);
  const material = props.android ?? materialNameFor(props.name);
  const ready = state.kind === "ready" ? state.symbol : null;
  return h(
    "span",
    {
      ref,
      "data-dnx-system-icon": props.name,
      "data-dnx-icon-source": ready ? "sf" : "material",
      className: props.className,
      role: props.label ? "img" : undefined,
      "aria-label": props.label,
      "aria-hidden": props.label ? undefined : "true",
      style: {
        display: "inline-block",
        flex: "none",
        width: size,
        height: size,
        lineHeight: 0,
        verticalAlign: "middle",
        color: props.color,
        visibility: state.kind === "pending" ? "hidden" : undefined,
        ...(ready ? nativeStyle(ready, mode) : {}),
        ...(props.style ?? {}),
      },
    },
    ready ? null : materialSvg(material, size),
  );
}
