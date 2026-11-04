// The supply-chain gates a project sets in its `.npmrc`, carried into a generated config.
//
// Deno reads `.npmrc` next to the workspace root's deno.json or package.json (and in the home
// directory). A build child that runs with a config denext generates under `.denext/`
// (`module-config.json`, `css-config.json`, the compile config) has `.denext/` as that root, so the
// project's `.npmrc` is never read there: `paranoid=true` or `advisory-check=required` set in it
// would not hold for the child's npm resolution. Copying the file is no answer (it may hold
// registry credentials), so the six supply-chain keys alone are translated into the generated
// config's `supplyChain`, merged with deno.json's the way the runtime merges sources: where both
// set one, the stricter value wins. The home `.npmrc` and `npm_config_*` still reach the child.

/** A key of `.npmrc` text (`key=value`, `;` / `#` comments), or undefined; the last one wins. */
export function npmrcValue(text: string, key: string): string | undefined {
  let found: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq > 0 && line.slice(0, eq).trim() === key) found = line.slice(eq + 1).trim();
  }
  return found;
}

/** npm's boolean text, as the runtime reads it (`true` / `1`, `false` / `0` / empty). */
const NPM_BOOL: Readonly<Record<string, boolean>> = {
  true: true,
  "1": true,
  false: false,
  "0": false,
  "": false,
};

/** `advisory-check` values, least strict first, and the aliases the runtime takes. */
const ADVISORY = ["off", "on", "required"] as const;
const ADVISORY_ALIASES: Readonly<Record<string, string>> = { false: "off", true: "on" };
/** `low-download-check` values, least strict first, and the aliases the runtime takes. */
const LOW_DOWNLOAD = ["off", "warn", "prompt", "required"] as const;
const LOW_DOWNLOAD_ALIASES: Readonly<Record<string, string>> = {
  false: "off",
  on: "prompt",
  true: "prompt",
};

/** An `.npmrc` key's value, trimmed (undefined when unset). */
function key(npmrc: string, name: string): string | undefined {
  return npmrcValue(npmrc, name)?.trim();
}

/** A level of `order` (or an alias of one), or undefined. */
function level(
  order: readonly string[],
  aliases: Readonly<Record<string, string>>,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const v = Object.hasOwn(aliases, value) ? aliases[value] : value;
  return order.includes(v) ? v : undefined;
}

/** The stricter of deno.json's level and the `.npmrc`'s (undefined: nothing to change). */
function stricter(order: readonly string[], own: unknown, npmrc: string | undefined): unknown {
  if (npmrc === undefined) return undefined;
  const ia = typeof own === "string" ? order.indexOf(own) : -1;
  return ia >= order.indexOf(npmrc) ? undefined : npmrc;
}

/** How one deno.json key takes the `.npmrc`'s: its new value, or undefined to keep it. */
type Merge = (own: unknown, npmrc: string) => unknown;

/** `paranoid=true` turns it on; `paranoid=false` asks for nothing (it opts out of nothing). */
const mergeParanoid: Merge = (_own, npmrc) =>
  NPM_BOOL[key(npmrc, "paranoid") ?? "-"] === true ? true : undefined;

/** `jail-scripts`: on wins; an exceptions object in deno.json is kept as it is. */
const mergeJail: Merge = (own, npmrc) => {
  const v = key(npmrc, "jail-scripts");
  if (v === undefined || !Object.hasOwn(NPM_BOOL, v)) return undefined;
  if (own !== undefined && typeof own !== "boolean") return undefined;
  return own === true || NPM_BOOL[v];
};

/** `low-download-threshold`: 0 is off, so any other value is stricter; else the higher. */
const mergeThreshold: Merge = (own, npmrc) => {
  const t = Number(key(npmrc, "low-download-threshold") ?? NaN);
  if (!Number.isSafeInteger(t) || t < 0) return undefined;
  const mine = typeof own === "number" ? own : 0;
  return mine === 0 || t === 0 ? mine || t : Math.max(mine, t);
};

/** `allowed-unpopular-packages`: the union. */
const mergeAllowed: Merge = (own, npmrc) => {
  const listed = (key(npmrc, "allowed-unpopular-packages") ?? "").split(",")
    .map((s) => s.trim()).filter((s) => s !== "");
  const mine = Array.isArray(own) ? own : [];
  const union = [...new Set([...mine, ...listed])];
  return union.length === mine.length ? undefined : union;
};

/** deno.json's `supplyChain` keys and how each takes the `.npmrc`'s. */
const MERGES: readonly (readonly [string, Merge])[] = [
  ["paranoid", mergeParanoid],
  ["jailScripts", mergeJail],
  [
    "advisoryCheck",
    (own, rc) =>
      stricter(ADVISORY, own, level(ADVISORY, ADVISORY_ALIASES, key(rc, "advisory-check"))),
  ],
  [
    "lowDownloadCheck",
    (own, rc) =>
      stricter(
        LOW_DOWNLOAD,
        own,
        level(LOW_DOWNLOAD, LOW_DOWNLOAD_ALIASES, key(rc, "low-download-check")),
      ),
  ],
  ["lowDownloadThreshold", mergeThreshold],
  ["allowLowDownloads", mergeAllowed],
];

/**
 * The project `.npmrc`'s supply-chain settings in deno.json's `supplyChain` form, merged into
 * deno.json's own (`base`, not changed): `paranoid`, `jail-scripts`, `advisory-check`,
 * `low-download-check`, `low-download-threshold` (0 is off, so any other value is stricter) and
 * `allowed-unpopular-packages` (a union). A deno.json `jailScripts` exceptions object is kept as
 * it is: it already asks for the jail unless it lists only `packages`, and the runtime's default
 * (on from 3.0.0-rc.5) covers that case. No other `.npmrc` key is read.
 *
 * @param base deno.json's `supplyChain` (or undefined).
 * @param npmrc The project's `.npmrc` text (or null).
 * @returns The merged object, or `base` itself when the `.npmrc` changes nothing.
 */
export function withNpmrcSupplyChain(base: unknown, npmrc: string | null): unknown {
  if (npmrc === null) return base;
  const isObject = base !== null && typeof base === "object" && !Array.isArray(base);
  const out: Record<string, unknown> = isObject ? { ...base as Record<string, unknown> } : {};
  let changed = false;
  for (const [name, merge] of MERGES) {
    const next = merge(out[name], npmrc);
    if (next === undefined || next === out[name]) continue;
    out[name] = next;
    changed = true;
  }
  return changed ? out : base;
}
