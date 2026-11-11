// Loopy's settings: how a voice turn starts (each activation switchable), which tools it may use
// (web search, the browser, memory; each can be switched off at any time) and Loopy's size. Kept in
// the page's localStorage like the read-aloud toggle (the API key is NOT here: it lives in the OS
// keychain or the dev server's environment, voice/keys.ts). Pure apart from the storage it is
// handed, so it is unit-tested.

/** Where the settings are kept. */
export const SETTINGS_KEY = "loopy.settings";

/** Loopy's size, in percent of the base drawing (and of the 260 × 300 window). */
export const SCALE = { min: 75, max: 250, step: 5, default: 125 } as const;

/** The global push-to-talk shortcut (press to start a turn, press again to send it). */
export const GLOBAL_SHORTCUT = "CommandOrControl+Shift+Space";

/** The key held for push-to-talk while Loopy's window (or page) has the focus. */
export const PUSH_TO_TALK_KEY = "Space";

/** Loopy's settings. */
export interface LoopySettings {
  /** Hold {@linkcode PUSH_TO_TALK_KEY} to talk while the window has the focus. */
  readonly pushToTalk: boolean;
  /** Click Loopy to start a turn, and again to send it. */
  readonly clickToTalk: boolean;
  /** {@linkcode GLOBAL_SHORTCUT} from any app (desktop only; off until turned on). */
  readonly globalShortcut: boolean;
  /** "Hey Loopy" (not built yet: always off). */
  readonly wakeWord: false;
  /** Loopy may search the web (`web_search`). */
  readonly webSearch: boolean;
  /** Loopy may drive a browser window (off until turned on). */
  readonly browser: boolean;
  /** Loopy keeps and recalls past conversations (off until turned on: nothing is kept while off). */
  readonly memory: boolean;
  /** Loopy's size in percent. */
  readonly scale: number;
}

/** The settings before any are changed. */
export const DEFAULT_SETTINGS: LoopySettings = {
  pushToTalk: true,
  clickToTalk: true,
  globalShortcut: false,
  wakeWord: false,
  webSearch: true,
  browser: false,
  memory: false,
  scale: SCALE.default,
};

/** The tool features the settings switch on, as the backend takes them. */
export function featuresOf(
  settings: LoopySettings,
): { webSearch: boolean; browser: boolean; memory: boolean } {
  return { webSearch: settings.webSearch, browser: settings.browser, memory: settings.memory };
}

/** The slice of `Storage` the settings use. */
export type SettingsStorage = Pick<Storage, "getItem" | "setItem">;

/** `value` as a size: a whole step within {@linkcode SCALE}, or `undefined` when not a number. */
export function clampScale(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  const stepped = Math.round(n / SCALE.step) * SCALE.step;
  return Math.min(SCALE.max, Math.max(SCALE.min, stepped));
}

/**
 * A `?scale=` query value as a size: a percentage (`150`) or a factor (`1.5`, anything up to 5),
 * or `undefined` when absent or not a number.
 */
export function scaleFromQuery(search: string): number | undefined {
  const raw = new URLSearchParams(search).get("scale");
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw.replace(/%$/, ""));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return clampScale(n <= 5 ? n * 100 : n);
}

/** A boolean field of `raw`, else `fallback`. */
const flag = (raw: Record<string, unknown>, key: string, fallback: boolean) =>
  typeof raw[key] === "boolean" ? raw[key] as boolean : fallback;

/** The kept settings, each field checked (a missing or bad one takes its default). */
export function loadSettings(storage: SettingsStorage | undefined): LoopySettings {
  let raw: unknown;
  try {
    raw = JSON.parse(storage?.getItem(SETTINGS_KEY) ?? "null");
  } catch {
    raw = null; // unreadable, or storage refused (a private window)
  }
  if (typeof raw !== "object" || raw === null) return DEFAULT_SETTINGS;
  const r = raw as Record<string, unknown>;
  return {
    pushToTalk: flag(r, "pushToTalk", DEFAULT_SETTINGS.pushToTalk),
    clickToTalk: flag(r, "clickToTalk", DEFAULT_SETTINGS.clickToTalk),
    globalShortcut: flag(r, "globalShortcut", DEFAULT_SETTINGS.globalShortcut),
    wakeWord: false,
    webSearch: flag(r, "webSearch", DEFAULT_SETTINGS.webSearch),
    browser: flag(r, "browser", DEFAULT_SETTINGS.browser),
    memory: flag(r, "memory", DEFAULT_SETTINGS.memory),
    scale: clampScale(r.scale) ?? DEFAULT_SETTINGS.scale,
  };
}

/** Keep `settings`; a refused write leaves them for this session only. */
export function saveSettings(storage: SettingsStorage | undefined, settings: LoopySettings): void {
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, wakeWord: false }));
  } catch { /* not kept */ }
}
