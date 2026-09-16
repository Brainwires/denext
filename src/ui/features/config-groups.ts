// Which view of `denext.config.ts` a key belongs to, and the filter that cuts across all of them.
//
// The config editor renders one collapsible section per top-level key. That is 28 schema keys
// plus whatever else the file declares plus the raw-file escape hatch — ~76 KB of markup in one
// page, which is a lot of scrolling to reach the one key you came for. The keys are grouped by
// what they configure, so a view carries a handful of sections instead of all of them.
//
// Grouping is a presentation decision and lives here rather than in the schema: the schema
// describes the config's SHAPE, and nothing about `basePath` says "routing" to a validator.

/** The config views, in strip order. */
export const CONFIG_GROUPS = ["routing", "rendering", "security", "data", "advanced"] as const;

/** One of {@linkcode CONFIG_GROUPS}. */
export type ConfigGroup = typeof CONFIG_GROUPS[number];

/** What each view is called in the strip. */
export const GROUP_LABEL: Record<ConfigGroup, string> = {
  routing: "Routing",
  rendering: "Rendering",
  security: "Security",
  data: "Data",
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
    "images",
    "tailwind",
    "mdx",
  ],
  security: ["csp", "hsts", "publicEnv", "apiBatch", "apiMaxBodyBytes"],
  data: ["cache", "scheduledTasks"],
  advanced: ["experimental", "nodeResolve", "compatibilityMode", "plugins", "commands"],
};

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
 * The URL of one view. The default group is spelled `/config` with no query, so the panel's own
 * address stays the short one and a link to it does not rot if the default ever changes.
 *
 * @param group The view.
 * @returns Its path.
 */
export function groupHref(group: ConfigGroup): string {
  return group === DEFAULT_GROUP ? "/config" : `/config?group=${group}`;
}

/**
 * Whether a section matches a search.
 *
 * Matching is a case-insensitive substring over the key AND its schema description, so searching
 * "cache" finds `cacheComponents` by name and `experimental` by its prose. Every term has to
 * match something (AND semantics), which is how the docs-site search behaves.
 *
 * @param key The section's key.
 * @param description Its schema description, when it has one.
 * @param query The raw `?q=` value.
 * @returns Whether the section should be shown.
 */
export function matchesQuery(key: string, description: string | undefined, query: string): boolean {
  const haystack = `${key} ${description ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== "")
    .every((term) => haystack.includes(term));
}

/** The id of the whole-file escape hatch, which is placed like any other key. */
const RAW_SECTION = "raw-file";

/** What the escape hatch matches on, since it has no schema description of its own. */
const RAW_DESCRIPTION = "edit the whole file directly, the raw source escape hatch";

/** One section, as far as picking which to show is concerned. */
export interface GroupableSection {
  /** The top-level key. */
  readonly key: string;
  /** Its schema description, when the schema describes it. */
  readonly description?: string;
}

/**
 * Which sections a request shows, and whether the raw-file editor is among them.
 *
 * A search cuts across every group — you are looking for a key, not for a view — so a query
 * ignores `group` entirely. Without one, the view decides. Kept here beside {@linkcode groupOf}
 * so the panel component only renders what it is handed.
 *
 * @param sections Every section the config has, in the order they should render.
 * @param group The view, used only when there is no query.
 * @param query The `?q=` filter (`""` for none).
 * @returns The sections to render, and whether the escape hatch belongs on this page.
 */
export function visibleSections<T extends GroupableSection>(
  sections: readonly T[],
  group: ConfigGroup,
  query: string,
): { shown: readonly T[]; rawHere: boolean } {
  if (query === "") {
    return {
      shown: sections.filter((section) => groupOf(section.key) === group),
      rawHere: groupOf(RAW_SECTION) === group,
    };
  }
  return {
    shown: sections.filter((section) => matchesQuery(section.key, section.description, query)),
    rawHere: matchesQuery(RAW_SECTION, RAW_DESCRIPTION, query),
  };
}

/**
 * What a filtered page says above its results.
 *
 * @param count How many sections matched.
 * @param query The search that produced them.
 * @returns The sentence to show.
 */
export function matchNote(count: number, query: string): string {
  if (count === 0) return `No config key matches "${query}".`;
  return `${count} key${count === 1 ? "" : "s"} match "${query}" — across every group.`;
}
