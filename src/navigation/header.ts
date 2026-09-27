/**
 * The stack's native-style header: a back button (the iOS chevron with the previous screen's
 * title, or Android's arrow), the title, and leading/trailing slots, plus the iOS large title
 * that collapses into the bar as the screen scrolls.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import type { NavigationPlatform, ScreenOptions } from "./types.ts";

/** Props of {@linkcode StackHeader}. */
export interface StackHeaderProps {
  /** The screen's options (`title`, `headerLargeTitle`, `headerLeft`, `headerRight`, …). */
  readonly options: ScreenOptions;
  /** The look. */
  readonly platform: NavigationPlatform;
  /** Whether to draw the back button. */
  readonly canGoBack: boolean;
  /** The back link's target (it works without JavaScript); omitted, the button is a `<button>`. */
  readonly backHref?: string;
  /** The iOS back label (the previous screen's title). */
  readonly backTitle?: string;
  /** Go back. */
  readonly onBack: () => void;
}

/** The iOS back chevron. */
function chevron(): VNode {
  return h(
    "svg",
    { width: 13, height: 21, viewBox: "0 0 13 21", "aria-hidden": "true", focusable: "false" },
    h("path", {
      d: "M11 2 2.5 10.5 11 19",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 3,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
}

/** The Material back arrow. */
function arrow(): VNode {
  return h(
    "svg",
    { width: 24, height: 24, viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" },
    h("path", {
      d: "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z",
      fill: "currentColor",
    }),
  );
}

/** The back control: a link when there is a target (no-JS back works), else a button. */
function backControl(
  props: StackHeaderProps,
  label: VNodeChildren,
  style: Record<string, unknown>,
): VNode {
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    props.onBack();
  };
  const common = {
    "data-dnx-back": "",
    "aria-label": props.options.headerBackTitle ?? props.backTitle ?? "Back",
    onClick,
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      color: "var(--dnx-header-tint, LinkText)",
      textDecoration: "none",
      background: "none",
      border: 0,
      padding: 0,
      font: "inherit",
      cursor: "pointer",
      ...style,
    },
  };
  return props.backHref
    ? h("a", { ...common, href: props.backHref }, label)
    : h("button", { ...common, type: "button" }, label);
}

/** The header bar's own style (safe-area aware, above the screen's scroller). */
function barStyle(platform: NavigationPlatform): Record<string, unknown> {
  return {
    flex: "none",
    position: "relative",
    zIndex: 1,
    boxSizing: "content-box",
    paddingTop: "var(--dnx-header-inset, env(safe-area-inset-top, 0px))",
    height: platform === "ios" ? 44 : 56,
    display: "flex",
    alignItems: "center",
    gap: 8,
    paddingInline: platform === "ios" ? 8 : 4,
    background: "var(--dnx-header-bg, Canvas)",
    color: "var(--dnx-header-fg, CanvasText)",
    borderBottom: platform === "ios" ? "0.5px solid rgba(127, 127, 127, 0.35)" : "none",
    boxShadow: platform === "android" ? "0 1px 3px rgba(0, 0, 0, 0.12)" : "none",
  };
}

/** The title element (a heading, for assistive technology). */
function titleEl(title: VNodeChildren, style: Record<string, unknown>): VNode {
  return h("div", {
    "data-dnx-header-title": "",
    role: "heading",
    "aria-level": 1,
    style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", ...style },
  }, title);
}

/** The Material header: back arrow, left-aligned title, trailing slot. */
function androidHeader(props: StackHeaderProps, showBack: boolean, title: VNodeChildren): VNode {
  const { options } = props;
  const back = showBack
    ? backControl(props, arrow(), {
      width: 48,
      height: 48,
      justifyContent: "center",
      color: "inherit",
      borderRadius: 24,
    })
    : null;
  const right = options.headerRight
    ? h(
      "div",
      { "data-dnx-header-right": "", style: { flex: "none", display: "flex" } },
      options.headerRight,
    )
    : null;
  return h(
    "header",
    { "data-dnx-header": "android", style: barStyle("android") },
    back,
    options.headerLeft ?? null,
    titleEl(title, {
      flex: 1,
      minWidth: 0,
      fontSize: 20,
      fontWeight: 500,
      paddingInline: showBack ? 4 : 12,
    }),
    right,
  );
}

/** The iOS header: chevron + back label, centered title (hidden under a large title), trailing slot. */
function iosHeader(props: StackHeaderProps, showBack: boolean, title: VNodeChildren): VNode {
  const { options } = props;
  const backLabel = options.headerBackTitle ?? props.backTitle ?? "Back";
  const back = showBack
    ? backControl(props, [
      chevron(),
      h("span", {
        style: {
          maxWidth: 120,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        },
      }, backLabel),
    ], { fontSize: 17 })
    : null;
  return h(
    "header",
    {
      "data-dnx-header": "ios",
      style: { ...barStyle("ios"), display: "grid", gridTemplateColumns: "1fr auto 1fr" },
    },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 } },
      back,
      options.headerLeft ?? null,
    ),
    titleEl(title, {
      fontSize: 17,
      fontWeight: 600,
      textAlign: "center",
      maxWidth: "60vw",
      opacity: options.headerLargeTitle === true ? 0 : 1,
      transition: "opacity 150ms linear",
    }),
    h(
      "div",
      {
        "data-dnx-header-right": "",
        style: { display: "flex", justifyContent: "flex-end", gap: 8 },
      },
      options.headerRight ?? null,
    ),
  );
}

/**
 * A native-style header for a stack screen. {@linkcode StackLayout} draws it when a screen's
 * `headerShown` is `true`; it is exported for custom headers that want the same look.
 */
export function StackHeader(props: StackHeaderProps): VNode {
  const showBack = props.canGoBack && props.options.headerBackVisible !== false;
  const title = props.options.headerTitle ?? props.options.title ?? "";
  return props.platform === "android"
    ? androidHeader(props, showBack, title)
    : iosHeader(props, showBack, title);
}

/** The iOS large title drawn at the top of the screen's content, above the page. */
export function LargeTitle(props: { title: VNodeChildren }): VNode {
  return h("div", {
    "data-dnx-large-title": "",
    "aria-hidden": "true",
    style: {
      fontSize: 34,
      fontWeight: 700,
      lineHeight: "41px",
      padding: "4px 16px 8px",
      letterSpacing: "0.01em",
    },
  }, props.title);
}

/** How far, in px, the content scrolls before the large title has collapsed into the bar. */
export const LARGE_TITLE_COLLAPSE = 44;
