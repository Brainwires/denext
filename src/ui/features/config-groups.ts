// Which view of `denext.config.ts` a key belongs to, and the filter that cuts across all of them.
//
// The config editor renders one collapsible section per top-level key. That is ~30 schema keys
// plus whatever else the file declares plus the raw-file escape hatch — ~76 KB of markup in one
// page, which is a lot of scrolling to reach the one key you came for. The keys are grouped by
// what they configure, so a view carries a handful of sections instead of all of them.
//
// Grouping is a presentation decision and lives here rather than in the schema: the schema
// describes the config's SHAPE, and nothing about `basePath` says "routing" to a validator.

/** The config views, in strip order. */
export const CONFIG_GROUPS = ["routing", "rendering", "security", "advanced"] as const;

/** One of {@linkcode CONFIG_GROUPS}. */
export type ConfigGroup = typeof CONFIG_GROUPS[number];

/** What each view is called in the strip. */
export const GROUP_LABEL: Record<ConfigGroup, string> = {
  routing: "Routing",
  rendering: "Rendering",
  security: "Security",
  advanced: "Advanced",
};

/** The view a bare `/config` opens on — the keys most projects set first. */
export const DEFAULT_GROUP: ConfigGroup = "routing";

/**
 * Which keys each view owns. Every key the schema describes appears exactly once; a key the
 * schema does NOT describe (one this file declares and denext does not know) falls to
 * `advanced`, which is also where the whole-file escape hatch lives.
 */
const GROUP_KEYS: Record<ConfigGroup, readonly string[]> = {
  routing: ["basePath", "trailingSlash", "assetPrefix", "redirects", "rewrites", "headers", "i18n"],
  rendering: [
    "mode",
    "spa",
    "streaming",
    "live",
    "cacheComponents",
    "classComponents",
    "reactCompiler",
    "asyncContext",
    // Client-runtime behaviour (iOS momentum scrolling), not a toolchain switch.
    "momentumSafeScroll",
    "images",
    "tailwind",
    "mdx",
    "cache",
  ],
  // The production-server keys a proxy or a body cap forces you to set sit with the other
  // request-facing switches; the capacity knobs stay on Advanced by the fallback rule.
  security: [
    "csp",
    "hsts",
    "publicEnv",
    "apiBatch",
    "apiMaxBodyBytes",
    "actionMaxBodyBytes",
    "canonicalOrigin",
    "trustForwardedHeaders",
  ],
  // `features` (compile-time flags) sits with the other build-and-toolchain switches; `experimental`
  // is the superseded block every key graduated out of, kept here so a file that still sets it
  // is edited where it always was (the schema marks it deprecated, so an absent one is not offered).
  // `optimizePackageImports` is a bundler switch, so it sits beside `features`.
  advanced: [
    "features",
    "optimizePackageImports",
    "experimental",
    "nodeResolve",
    "compatibilityMode",
    // The React Native resolve mode is a bundler switch too.
    "reactNative",
    "plugins",
    "commands",
  ],
};

/**
 * Keys whose editor lives on another panel altogether.
 *
 * `scheduledTasks` and `tasks` are cron. The Cron page already writes both — the schedules as
 * rows, the history as a toggle — and a second editor for them here would mean two forms, two
 * `_base` stamps and two ways to disagree about one key. They stay in the `/api/config` twin,
 * which reports what the file holds; they are simply not edited from the key views.
 *
 * `Data` retired with them: `cache` was all that remained, and a whole view for one key is worse
 * than that key sitting beside `cacheComponents` on Rendering.
 */
const OWNED_ELSEWHERE: ReadonlyMap<string, string> = new Map([
  ["scheduledTasks", "/config/cron"],
  ["tasks", "/config/cron"],
]);

/**
 * Where a key is edited, when it is not edited here.
 *
 * @param key A top-level config key.
 * @returns The panel that owns it, or `null` when the key views do.
 */
export function ownedElsewhere(key: string): string | null {
  return OWNED_ELSEWHERE.get(key) ?? null;
}

/** Key → group, built once from {@linkcode GROUP_KEYS}. */
const GROUP_OF = new Map<string, ConfigGroup>(
  CONFIG_GROUPS.flatMap((group) => GROUP_KEYS[group].map((key) => [key, group] as const)),
);

/**
 * The view that owns `key`.
 *
 * @param key A top-level config key (or the raw-file section's id).
 * @returns Its group; `advanced` for anything this module does not place, so a key denext does
 * not describe still has a home rather than disappearing from the editor.
 */
export function groupOf(key: string): ConfigGroup {
  return GROUP_OF.get(key) ?? "advanced";
}

/**
 * Whether `value` names a view.
 *
 * @param value A `?group=` value, or anything else.
 * @returns Whether it is one of {@linkcode CONFIG_GROUPS}.
 */
export function isConfigGroup(value: string | null): value is ConfigGroup {
  return value !== null && (CONFIG_GROUPS as readonly string[]).includes(value);
}

/**
 * The URL of one view — its own path, as every other destination in this UI has.
 *
 * Every view is spelled the same way, the default included. A bare `/config` used to be the
 * default's short address, which made it the one page whose URL did not say which view it was.
 *
 * @param group The view.
 * @returns Its path.
 */
export function groupHref(group: ConfigGroup): string {
  return `/config/${group}`;
}

/** The id of the whole-file escape hatch, which is placed like any other key. */
const RAW_SECTION = "raw-file";

/** One section, as far as picking which to show is concerned. */
export interface GroupableSection {
  /** The top-level key. */
  readonly key: string;
  /** Its schema description, when the schema describes it. */
  readonly description?: string;
}

/**
 * Which sections a view shows, and whether the raw-file editor is among them.
 *
 * There is no search any more: the keys are organised into views and, within a view, into tabs,
 * so finding one is navigation rather than a query. Kept here beside {@linkcode groupOf} so the
 * panel component only renders what it is handed.
 *
 * @param sections Every section the config has, in the order they should render.
 * @param group The view being rendered.
 * @returns The sections to render, and whether the escape hatch belongs on this page.
 */
export function visibleSections<T extends GroupableSection>(
  sections: readonly T[],
  group: ConfigGroup,
): { shown: readonly T[]; rawHere: boolean } {
  // A key another panel owns is not shown here: its editor lives on the page that owns it, and
  // two editors for one key could write it from two forms with different stamps.
  const mine = sections.filter((section) => !OWNED_ELSEWHERE.has(section.key));
  return {
    shown: mine.filter((section) => groupOf(section.key) === group),
    rawHere: groupOf(RAW_SECTION) === group,
  };
}
