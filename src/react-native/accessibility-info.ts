/**
 * React Native's `AccessibilityInfo` for React Native mode: the accessibility settings a web
 * view can read (reduced motion, reduced transparency, increased contrast, inverted colors,
 * through CSS media queries), announcements through an ARIA live region, and focus moves.
 * react-native-web ships it as a mock whose `isScreenReaderEnabled()` always resolves `true`.
 *
 * Whether VoiceOver / TalkBack is running is not visible to a web page, in a browser or in the
 * Capacitor shell's WebView. A native plugin registered as `DenextAccessibility` (with
 * `isScreenReaderEnabled()` resolving `{ value }` and a `screenReaderChanged` event) is used
 * when present; denext does not ship one yet, so the answer is otherwise `false`.
 *
 * @module
 */

import { listenerDisposer, type ListenerHandle, nativePlugin } from "../mobile/plugin.ts";
import {
  type EmitterSubscription,
  type HandlerSubscriptions,
  handlerSubscriptions,
  mediaMatches,
  watchMedia,
} from "./internal.ts";

/** The events `AccessibilityInfo.addEventListener` accepts. */
export type AccessibilityChangeEventName =
  | "boldTextChanged"
  | "grayscaleChanged"
  | "invertColorsChanged"
  | "reduceMotionChanged"
  | "highTextContrastChanged"
  | "darkerSystemColorsChanged"
  | "screenReaderChanged"
  | "reduceTransparencyChanged"
  | "accessibilityServiceChanged"
  | "announcementFinished";

/** What an `announcementFinished` listener receives. */
export interface AnnouncementFinishedEvent {
  readonly announcement: string;
  readonly success: boolean;
}

/** React Native's `AccessibilityInfo` module. */
export interface AccessibilityInfoStatic {
  isBoldTextEnabled(): Promise<boolean>;
  isGrayscaleEnabled(): Promise<boolean>;
  isInvertColorsEnabled(): Promise<boolean>;
  isReduceMotionEnabled(): Promise<boolean>;
  isHighTextContrastEnabled(): Promise<boolean>;
  isDarkerSystemColorsEnabled(): Promise<boolean>;
  prefersCrossFadeTransitions(): Promise<boolean>;
  isReduceTransparencyEnabled(): Promise<boolean>;
  isScreenReaderEnabled(): Promise<boolean>;
  isAccessibilityServiceEnabled(): Promise<boolean>;
  /** Deprecated alias of `isScreenReaderEnabled`. */
  fetch(): Promise<boolean>;
  addEventListener(
    eventName: AccessibilityChangeEventName,
    handler: (event: boolean | AnnouncementFinishedEvent) => void,
  ): EmitterSubscription;
  /** Removed in React Native 0.65; kept for older libraries. */
  removeEventListener(
    eventName: AccessibilityChangeEventName,
    handler: (event: boolean | AnnouncementFinishedEvent) => void,
  ): void;
  setAccessibilityFocus(reactTag: unknown): void;
  sendAccessibilityEvent(handle: unknown, eventType: string): void;
  announceForAccessibility(announcement: string): void;
  announceForAccessibilityWithOptions(
    announcement: string,
    options: { queue?: boolean },
  ): void;
  getRecommendedTimeoutMillis(originalTimeout: number): Promise<number>;
}

/** The media query behind each setting a web view can read. */
const MEDIA: Readonly<Partial<Record<AccessibilityChangeEventName, string>>> = {
  reduceMotionChanged: "(prefers-reduced-motion: reduce)",
  reduceTransparencyChanged: "(prefers-reduced-transparency: reduce)",
  highTextContrastChanged: "(prefers-contrast: more)",
  darkerSystemColorsChanged: "(prefers-contrast: more)",
  invertColorsChanged: "(inverted-colors: inverted)",
};

/** The JS side of an app-registered `DenextAccessibility` plugin. */
interface AccessibilityPlugin {
  isScreenReaderEnabled(): Promise<{ value?: boolean }>;
  addListener(
    eventName: "screenReaderChanged",
    listener: (event?: { value?: boolean }) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

/** The registrations by handler, for the deprecated `removeEventListener`. */
let registered: HandlerSubscriptions | undefined;

/** Announcement listeners (`announcementFinished`). */
let announced: Set<(event: AnnouncementFinishedEvent) => void> | undefined;

/** The screen-reader plugin, when the shell registers one. */
function screenReaderPlugin(): AccessibilityPlugin | undefined {
  return nativePlugin<AccessibilityPlugin>("DenextAccessibility", [
    "isScreenReaderEnabled",
    "addListener",
  ]);
}

/** Whether a screen reader runs: the native plugin's answer, else `false`. */
async function screenReaderEnabled(): Promise<boolean> {
  const plugin = screenReaderPlugin();
  if (!plugin) return false;
  try {
    return (await plugin.isScreenReaderEnabled())?.value === true;
  } catch {
    return false;
  }
}

/** Start the source behind `eventName` for `handler`; returns the stop function. */
function watch(
  eventName: AccessibilityChangeEventName,
  handler: (event: boolean | AnnouncementFinishedEvent) => void,
): () => void {
  const query = MEDIA[eventName];
  if (query) return watchMedia(query, handler);
  if (eventName === "screenReaderChanged" || eventName === "accessibilityServiceChanged") {
    const plugin = screenReaderPlugin();
    if (!plugin) return () => {};
    return listenerDisposer(
      plugin.addListener("screenReaderChanged", (e) => handler(e?.value === true)),
    );
  }
  if (eventName === "announcementFinished") {
    const set = announced ??= new Set();
    set.add(handler);
    return () => set.delete(handler);
  }
  return () => {};
}

/** The live regions, created on first announcement: polite and assertive. */
let regions: { polite?: LiveRegion; assertive?: LiveRegion } = {};

/** The slice of an element a live region uses. */
interface LiveRegion {
  textContent: string;
  setAttribute(name: string, value: string): void;
  readonly style: { cssText: string };
  readonly isConnected?: boolean;
}

/** The live region for `politeness`, created (visually hidden) on first use. */
function liveRegion(politeness: "polite" | "assertive"): LiveRegion | undefined {
  if (typeof document === "undefined" || !document.body) return undefined;
  const existing = regions[politeness];
  if (existing && existing.isConnected !== false) return existing;
  const el = document.createElement("div") as unknown as LiveRegion;
  el.setAttribute("aria-live", politeness);
  el.setAttribute("aria-atomic", "true");
  el.setAttribute("data-denext-announcer", politeness);
  el.style.cssText = "position:absolute;width:1px;height:1px;margin:-1px;padding:0;" +
    "overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0";
  document.body.appendChild(el as unknown as Node);
  regions = { ...regions, [politeness]: el };
  return el;
}

/** Test hook: forget the live regions and listeners. */
export function resetAccessibilityInfoForTesting(): void {
  regions = {};
  announced = undefined;
  registered = undefined;
}

/**
 * Announce `text`: clear the region, then set the text on the next task, so repeating the
 * same text is announced again; `announcementFinished` listeners hear `success: true` then
 * (the page cannot know when a screen reader finished speaking).
 */
function announce(text: string, politeness: "polite" | "assertive"): void {
  const region = liveRegion(politeness);
  if (!region) return;
  region.textContent = "";
  setTimeout(() => {
    region.textContent = text;
    for (const fn of [...(announced ?? [])]) fn({ announcement: text, success: true });
  }, 50);
}

/** The DOM node behind a React Native "tag": react-native-web's `findNodeHandle` is the node. */
function focusTarget(
  tag: unknown,
):
  | { focus(): void; setAttribute?(n: string, v: string): void; hasAttribute?(n: string): boolean }
  | undefined {
  const node = tag as { focus?: unknown; setAttribute?: unknown; hasAttribute?: unknown } | null;
  return typeof node?.focus === "function"
    ? node as {
      focus(): void;
      setAttribute?(n: string, v: string): void;
      hasAttribute?(n: string): boolean;
    }
    : undefined;
}

/** Move focus to `tag`'s node, making it programmatically focusable when it is not. */
function focusNode(tag: unknown): void {
  const node = focusTarget(tag);
  if (!node) return;
  if (node.hasAttribute?.("tabindex") === false) node.setAttribute?.("tabindex", "-1");
  node.focus();
}

/**
 * React Native's `AccessibilityInfo`, backed by what a web view can observe:
 *
 * - `isReduceMotionEnabled` / `reduceMotionChanged`: `prefers-reduced-motion: reduce`.
 * - `isReduceTransparencyEnabled` / `reduceTransparencyChanged`:
 *   `prefers-reduced-transparency: reduce` (where the engine supports it, else `false`).
 * - `isHighTextContrastEnabled`, `isDarkerSystemColorsEnabled` and their events:
 *   `prefers-contrast: more`.
 * - `isInvertColorsEnabled` / `invertColorsChanged`: `inverted-colors: inverted` (Safari).
 * - `isScreenReaderEnabled` / `isAccessibilityServiceEnabled` and their events: an
 *   app-registered `DenextAccessibility` native plugin when present, else `false` (no web
 *   API exposes it).
 * - `isBoldTextEnabled`, `isGrayscaleEnabled`, `prefersCrossFadeTransitions`: `false` (no
 *   web signal).
 * - `announceForAccessibility`: a visually hidden `aria-live="polite"` region
 *   (`announceForAccessibilityWithOptions(text, { queue: false })` uses an assertive one).
 * - `setAccessibilityFocus(node)`: focuses the node (react-native-web's `findNodeHandle`
 *   returns it), adding `tabindex="-1"` when it has none.
 *
 * @example
 * ```ts
 * import { AccessibilityInfo } from "react-native";
 *
 * const reduce = await AccessibilityInfo.isReduceMotionEnabled();
 * AccessibilityInfo.announceForAccessibility("Saved");
 * ```
 */
export const AccessibilityInfo: AccessibilityInfoStatic = {
  isBoldTextEnabled: () => Promise.resolve(false),
  isGrayscaleEnabled: () => Promise.resolve(false),
  isInvertColorsEnabled: () => Promise.resolve(mediaMatches(MEDIA.invertColorsChanged!)),
  isReduceMotionEnabled: () => Promise.resolve(mediaMatches(MEDIA.reduceMotionChanged!)),
  isHighTextContrastEnabled: () => Promise.resolve(mediaMatches(MEDIA.highTextContrastChanged!)),
  isDarkerSystemColorsEnabled: () =>
    Promise.resolve(mediaMatches(MEDIA.darkerSystemColorsChanged!)),
  prefersCrossFadeTransitions: () => Promise.resolve(false),
  isReduceTransparencyEnabled: () =>
    Promise.resolve(mediaMatches(MEDIA.reduceTransparencyChanged!)),
  isScreenReaderEnabled: screenReaderEnabled,
  isAccessibilityServiceEnabled: screenReaderEnabled,
  fetch: screenReaderEnabled,
  addEventListener(eventName, handler) {
    const stop = watch(eventName, handler);
    return (registered ??= handlerSubscriptions()).track(handler, stop);
  },
  removeEventListener(_eventName, handler) {
    registered?.removeAll(handler);
  },
  setAccessibilityFocus: focusNode,
  sendAccessibilityEvent(handle, eventType) {
    if (eventType === "focus") focusNode(handle);
  },
  announceForAccessibility(announcement) {
    announce(String(announcement), "polite");
  },
  announceForAccessibilityWithOptions(announcement, options) {
    announce(String(announcement), options?.queue === false ? "assertive" : "polite");
  },
  getRecommendedTimeoutMillis: (originalTimeout) => Promise.resolve(originalTimeout),
};
