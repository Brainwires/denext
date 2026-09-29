/**
 * React Native's `Vibration`, `Share` and `Clipboard` for React Native mode, over
 * `denext/mobile`'s haptics, share sheet and clipboard (the Capacitor plugins in the shell, the
 * web APIs elsewhere). react-native-web's versions use only the browser: no vibration in iOS
 * WebKit, `Share.share` rejects where `navigator.share` is missing (Android WebView) and
 * resolves without React Native's result, and `Clipboard.getString()` always resolves `""`.
 *
 * @module
 */

import { readClipboard, writeClipboard } from "../mobile/clipboard.ts";
import { nativePlugin } from "../mobile/plugin.ts";
import { share } from "../mobile/share.ts";

/** React Native's `Vibration` module. */
export interface VibrationStatic {
  vibrate(pattern?: number | readonly number[], repeat?: boolean): void;
  cancel(): void;
}

/** What `Share.share` shares. */
export interface ShareContent {
  readonly title?: string;
  readonly message?: string;
  readonly url?: string;
}

/** `Share.share` options (accepted; the share sheet takes none of them). */
export interface ShareOptions {
  readonly dialogTitle?: string;
  readonly excludedActivityTypes?: readonly string[];
  readonly tintColor?: string;
  readonly subject?: string;
  readonly anchor?: number;
}

/** What `Share.share` resolves with. */
export type ShareAction =
  | { action: "sharedAction"; activityType?: string | null }
  | { action: "dismissedAction"; activityType?: undefined };

/** React Native's `Share` module. */
export interface ShareStatic {
  share(content: ShareContent, options?: ShareOptions): Promise<ShareAction>;
  readonly sharedAction: "sharedAction";
  readonly dismissedAction: "dismissedAction";
}

/** React Native's (deprecated) `Clipboard` module. */
export interface ClipboardStatic {
  getString(): Promise<string>;
  setString(text: string): void;
  /** react-native-web's addition: whether copying can work here. */
  isAvailable(): boolean;
}

/** The slice of `@capacitor/haptics` vibration uses. */
interface HapticsVibrate {
  vibrate(options?: { duration?: number }): Promise<void>;
}

/** The slice of `@capacitor/clipboard` `isAvailable` checks for. */
interface ClipboardPluginShape {
  read(): Promise<unknown>;
  write(options: unknown): Promise<void>;
}

/** React Native's default vibration, in ms. */
const DEFAULT_MS = 400;

/** The pending pattern timers, so `cancel()` can stop them. */
let timers: Set<ReturnType<typeof setTimeout>> | undefined;

/** Schedule `fn` after `ms`, tracked for `cancel()`. */
function later(ms: number, fn: () => void): void {
  const set = timers ??= new Set();
  const timer = setTimeout(() => {
    set.delete(timer);
    fn();
  }, ms);
  set.add(timer);
}

/** Stop every pending pattern step. */
function clearTimers(): void {
  for (const timer of timers ?? []) clearTimeout(timer);
  timers?.clear();
}

/**
 * Play React Native's pattern (`[wait, vibrate, wait, vibrate, …]`) through the native plugin,
 * one `vibrate({ duration })` per step, looping while `repeat`.
 */
function playNative(plugin: HapticsVibrate, pattern: readonly number[], repeat: boolean): void {
  const loops = repeat && pattern.some((ms) => ms > 0);
  const step = (index: number): void => {
    if (index >= pattern.length) return loops ? step(0) : undefined;
    const ms = Math.max(0, pattern[index]);
    if (index % 2 === 1 && ms > 0) plugin.vibrate({ duration: ms }).catch(() => {});
    if (ms === 0) return step(index + 1);
    later(ms, () => step(index + 1));
  };
  step(0);
}

/** The browser's `navigator.vibrate`, when there is one. */
function webVibrate(): ((pattern: number | number[]) => boolean) | undefined {
  const nav = (globalThis as { navigator?: { vibrate?: (p: number | number[]) => boolean } })
    .navigator;
  return typeof nav?.vibrate === "function" ? nav.vibrate.bind(nav) : undefined;
}

/**
 * Play React Native's pattern through `navigator.vibrate`, whose patterns start with a vibration
 * rather than a wait (so a leading 0 ms vibration is added), repeating after the pattern's
 * length while `repeat`.
 */
function playWeb(
  vibrate: (p: number | number[]) => boolean,
  pattern: readonly number[],
  repeat: boolean,
) {
  vibrate([0, ...pattern]);
  if (!repeat) return;
  const total = pattern.reduce((sum, ms) => sum + Math.max(0, ms), 0);
  if (total > 0) later(total, () => playWeb(vibrate, pattern, repeat));
}

/**
 * React Native's `Vibration`: `vibrate()` (400 ms), `vibrate(ms)`, or a pattern
 * `[wait, vibrate, wait, vibrate, …]` in ms, repeated until `cancel()` when `repeat`. Inside the
 * shell with `@capacitor/haptics` (`denext mobile add haptics`) each vibration is the plugin's
 * `vibrate({ duration })` (iOS plays its own fixed-length vibration, as in React Native);
 * elsewhere `navigator.vibrate` (none in iOS WebKit).
 */
export const Vibration: VibrationStatic = {
  vibrate(pattern = DEFAULT_MS, repeat = false) {
    clearTimers();
    const steps = typeof pattern === "number" ? [0, pattern] : [...pattern];
    const plugin = nativePlugin<HapticsVibrate>("Haptics", ["vibrate"]);
    if (plugin) return playNative(plugin, steps, repeat && typeof pattern !== "number");
    const web = webVibrate();
    if (web) playWeb(web, steps, repeat && typeof pattern !== "number");
  },
  cancel() {
    clearTimers();
    webVibrate()?.(0);
  },
};

/**
 * React Native's `Share`: `Share.share({ title, message, url })` opens the share sheet through
 * `denext/mobile`'s `share` (`@capacitor/share` in the shell, `navigator.share` in a browser,
 * else a copy to the clipboard) and resolves `{ action: "sharedAction" }`, or
 * `{ action: "dismissedAction" }` when the user cancels. At least one of `message` and `url` is
 * required, as in React Native.
 */
export const Share: ShareStatic = {
  async share(content, _options) {
    if (typeof content !== "object" || content === null) {
      throw new TypeError("Share.share: content to share must be a valid object");
    }
    if (typeof content.url !== "string" && typeof content.message !== "string") {
      throw new TypeError("Share.share: at least one of URL and message is required");
    }
    const result = await share({
      ...(content.title ? { title: content.title } : {}),
      ...(content.message !== undefined ? { text: content.message } : {}),
      ...(content.url !== undefined ? { url: content.url } : {}),
    });
    return result === "cancelled"
      ? { action: "dismissedAction" }
      : { action: "sharedAction", activityType: null };
  },
  sharedAction: "sharedAction",
  dismissedAction: "dismissedAction",
};

/** Copy `text` with the legacy `execCommand("copy")`, as react-native-web does; whether it ran. */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  const doc = document as Document & { execCommand?: (c: string) => boolean };
  if (typeof doc.execCommand !== "function") return false;
  const node = document.createElement("textarea");
  node.value = text;
  node.setAttribute("readonly", "");
  node.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.appendChild(node);
  node.select?.();
  try {
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    node.remove();
  }
}

/**
 * React Native's `Clipboard` (deprecated in React Native, still exported): `getString()` and
 * `setString()` through `denext/mobile`'s clipboard (`@capacitor/clipboard` in the shell,
 * `navigator.clipboard` in a secure page). `getString()` resolves `""` when reading is not
 * allowed; `setString()` falls back to `execCommand("copy")` when there is no clipboard API.
 */
export const Clipboard: ClipboardStatic = {
  async getString() {
    try {
      return await readClipboard();
    } catch {
      return "";
    }
  },
  setString(text) {
    writeClipboard(String(text)).catch(() => void legacyCopy(String(text)));
  },
  isAvailable() {
    if (nativePlugin<ClipboardPluginShape>("Clipboard", ["read", "write"])) return true;
    const nav = (globalThis as { navigator?: { clipboard?: unknown } }).navigator;
    if (nav?.clipboard) return true;
    const doc = globalThis.document as
      | { queryCommandSupported?: (c: string) => boolean }
      | undefined;
    return doc?.queryCommandSupported?.("copy") === true;
  },
};
