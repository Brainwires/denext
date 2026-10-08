// The lists target of the native parity gate: React Native mode's list adapters against the
// real components they stand in for — prop names, ref-method names and (for the two packages)
// runtime export names.
//
//   EXPECTED (frozen in baselines/lists.baseline.json by `parity:native:refresh -- lists`):
//     • react-native FlatList / SectionList / VirtualizedList: the props React Native 0.86.3's
//       `.d.ts` declares for each list (its own and `@react-native/virtualized-lists`', plus the
//       ScrollView props in SCROLL_PROPS), and the public instance methods of the pinned
//       react-native-web 0.21.2's classes (what apps call on the ref today);
//     • @shopify/flash-list 2.3.2: `FlashListProps` (its own plus SCROLL_PROPS), `FlashListRef`,
//       and the package's runtime exports;
//     • @legendapp/list 3.4.0 (`/react-native`): `LegendListProps` (its own plus SCROLL_PROPS),
//       `LegendListRef`, and the entry's runtime exports.
//   ACTUAL (offline): the adapters' prop and ref interfaces (`deno doc` over
//     src/react-native/lists/types.ts, flash-list.ts and legend-list.ts, `extends` / `Omit`
//     resolved) and the shims' exports from src/react-native/lists/manifest.ts.
//
// A name the real side has and the adapter lacks fails the gate unless it is in
// baselines/lists.known-gaps.json (`parity:native:gaps -- lists` rewrites it), matches the
// policy pattern below, or is named by a documented `LIST_WAIVERS` entry (waivers.ts). Extra
// adapter names are reported, never a failure.

import { LIST_PACKAGES } from "../../../src/react-native/lists/manifest.ts";
import { npmInstall } from "./shared.ts";
import { LIST_WAIVERS, type ListWaiver } from "./waivers.ts";

const DIR = "scripts/parity/native/baselines";
const baselinePath = (root: string) => `${root}/${DIR}/lists.baseline.json`;
const gapsPath = (root: string) => `${root}/${DIR}/lists.known-gaps.json`;

/** The pinned versions (React Native: T3's; the packages: the manifest's). */
const PINS: Record<string, string> = {
  "react-native": "0.86.3",
  "react-native-web": "0.21.2",
  "@shopify/flash-list": LIST_PACKAGES["@shopify/flash-list"].pinned,
  "@legendapp/list": LIST_PACKAGES["@legendapp/list"].pinned,
};

/**
 * The ScrollView props the lists are held to (the ones the list requirements table tracks);
 * the rest of ScrollView's and View's props are not list API.
 */
export const SCROLL_PROPS: readonly string[] = [
  "automaticallyAdjustKeyboardInsets",
  "contentContainerStyle",
  "horizontal",
  "invertStickyHeaders",
  "keyboardDismissMode",
  "keyboardShouldPersistTaps",
  "maintainVisibleContentPosition",
  "nestedScrollEnabled",
  "onContentSizeChange",
  "onLayout",
  "onMomentumScrollBegin",
  "onMomentumScrollEnd",
  "onScroll",
  "onScrollBeginDrag",
  "onScrollEndDrag",
  "pagingEnabled",
  "refreshControl",
  "scrollEnabled",
  "scrollEventThrottle",
  "showsHorizontalScrollIndicator",
  "showsVerticalScrollIndicator",
  "snapToAlignment",
  "snapToInterval",
  "snapToOffsets",
  "stickyHeaderIndices",
  "style",
];

/** Names never compared: experimental / unstable API and React's own props. */
const WAIVED = /^(experimental_|unstable_|UNSTABLE_|_)|^(key|children)$/;

/** One target's names. */
export interface ListSurface {
  props?: string[];
  methods?: string[];
  exports?: string[];
}

/** The frozen EXPECTED side. */
interface ListsBaseline {
  versions: Record<string, string>;
  capturedAt: string;
  targets: Record<string, ListSurface>;
}

/** One missing name. */
export interface ListGap {
  target: string;
  kind: "prop" | "method" | "export";
  name: string;
}

/** The adapter interfaces and shim entries each target is compared with. */
const DENEXT: Record<string, { file: string; props?: string; ref?: string; pkg?: string }> = {
  "react-native#FlatList": {
    file: "src/react-native/lists/types.ts",
    props: "FlatListProps",
    ref: "FlatListRef",
  },
  "react-native#SectionList": {
    file: "src/react-native/lists/types.ts",
    props: "SectionListProps",
    ref: "SectionListRef",
  },
  "react-native#VirtualizedList": {
    file: "src/react-native/lists/types.ts",
    props: "VirtualizedListProps",
    ref: "VirtualizedListRef",
  },
  "@shopify/flash-list#FlashList": {
    file: "src/react-native/flash-list.ts",
    props: "FlashListProps",
    ref: "FlashListRef",
  },
  "@shopify/flash-list": { file: "", pkg: "@shopify/flash-list" },
  "@legendapp/list#LegendList": {
    file: "src/react-native/legend-list.ts",
    props: "LegendListProps",
    ref: "LegendListRef",
  },
  "@legendapp/list": { file: "", pkg: "@legendapp/list" },
};

// ── ACTUAL: denext's interfaces (deno doc) ─────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
type Json = any;

/** Every interface declared in `files`, by name. */
// fallow-ignore-next-line complexity -- CLI parity-report script; not unit-tested, CRAP is coverage-estimated
async function interfaces(root: string, files: string[]): Promise<Map<string, Json>> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", ...files.map((f) => `${root}/${f}`)],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) throw new Error(new TextDecoder().decode(out.stderr));
  const doc = JSON.parse(new TextDecoder().decode(out.stdout));
  const map = new Map<string, Json>();
  for (const node of Object.values(doc.nodes ?? {}) as Json[]) {
    for (const sym of node.symbols ?? []) {
      const dec = (sym.declarations ?? []).find((d: Json) => d.kind === "interface");
      if (dec) map.set(sym.name, dec.def);
    }
  }
  return map;
}

/** The string literals of a type (`"a" | "b"`). */
// fallow-ignore-next-line complexity -- CLI parity-report script; not unit-tested, CRAP is coverage-estimated
function literals(t: Json): string[] {
  if (t?.kind === "literal") return [t.value?.string].filter(Boolean);
  if (t?.kind === "union") return (t.value ?? []).flatMap(literals);
  return [];
}

/** An interface's member names, with local `extends` (and `Omit<…>`) resolved. */
// fallow-ignore-next-line complexity -- CLI parity-report script; not unit-tested, CRAP is coverage-estimated
function membersOf(name: string, all: Map<string, Json>, seen = new Set<string>()): Set<string> {
  const def = all.get(name);
  const out = new Set<string>();
  if (!def || seen.has(name)) return out;
  seen.add(name);
  for (const p of def.properties ?? []) out.add(p.name);
  for (const m of def.methods ?? []) out.add(m.name);
  for (const ext of def.extends ?? []) {
    for (const n of extendsMembers(ext, all, seen)) out.add(n);
  }
  return out;
}

/** The members an `extends` clause brings in. */
// fallow-ignore-next-line complexity -- CLI parity-report script; not unit-tested, CRAP is coverage-estimated
function extendsMembers(ext: Json, all: Map<string, Json>, seen: Set<string>): Set<string> {
  const ref = ext?.value;
  if (ref?.typeName !== "Omit") return membersOf(ref?.typeName, all, seen);
  const [base, keys] = ref.typeParams ?? [];
  const omitted = new Set(literals(keys));
  const members = membersOf(base?.value?.typeName, all, seen);
  return new Set([...members].filter((n) => !omitted.has(n)));
}

/** A shim's runtime export names (from the manifest). */
function shimExports(pkg: string): string[] {
  const p = LIST_PACKAGES[pkg];
  const reexports = p.reexports.map((n) => n.split(" as ").at(-1)!);
  return [...Object.keys(p.components), ...Object.keys(p.animated ?? {}), ...reexports];
}

/** denext's surface per target. */
export async function denextListSurfaces(root: string): Promise<Record<string, ListSurface>> {
  const files = [...new Set(Object.values(DENEXT).map((d) => d.file).filter(Boolean))];
  const all = await interfaces(root, files);
  const out: Record<string, ListSurface> = {};
  for (const [target, d] of Object.entries(DENEXT)) {
    out[target] = d.pkg
      ? { exports: shimExports(d.pkg) }
      : { props: [...membersOf(d.props!, all)], methods: [...membersOf(d.ref!, all)] };
  }
  return out;
}

// ── the diff ───────────────────────────────────────────────────────────────────────────

/** Whether a documented waiver names `name` of `target`. */
function listWaived(
  waivers: readonly ListWaiver[],
  target: string,
  kind: ListGap["kind"],
  name: string,
): boolean {
  return waivers.some((w) => w.target === target && w.kind === kind && w.names.includes(name));
}

/** Every EXPECTED name the adapters lack (waived names left out). */
// fallow-ignore-next-line complexity -- CLI parity-report script; not unit-tested, CRAP is coverage-estimated
export function listGaps(
  expected: Record<string, ListSurface>,
  actual: Record<string, ListSurface>,
  waivers: readonly ListWaiver[] = LIST_WAIVERS,
): ListGap[] {
  const gaps: ListGap[] = [];
  const kinds = [["props", "prop"], ["methods", "method"], ["exports", "export"]] as const;
  for (const [target, surface] of Object.entries(expected)) {
    for (const [field, kind] of kinds) {
      const have = new Set(actual[target]?.[field] ?? []);
      for (const name of surface[field] ?? []) {
        if (have.has(name) || WAIVED.test(name)) continue;
        if (!listWaived(waivers, target, kind, name)) gaps.push({ target, kind, name });
      }
    }
  }
  return gaps.sort((a, b) =>
    `${a.target}${a.kind}${a.name}`.localeCompare(`${b.target}${b.kind}${b.name}`)
  );
}

const gapKey = (g: ListGap) => `${g.target}#${g.kind}#${g.name}`;

/** Read a JSON file, or null. */
async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch {
    return null;
  }
}

/** How many names a surface holds. */
function sizeOf(s: ListSurface): number {
  return [s.props, s.methods, s.exports].reduce((n, list) => n + (list?.length ?? 0), 0);
}

/** Counts per target, for the report. */
function coverage(expected: Record<string, ListSurface>, gaps: ListGap[]): string[] {
  return Object.entries(expected).map(([target, s]) => {
    const missing = gaps.filter((g) => g.target === target).length;
    return `  ${target}: ${sizeOf(s) - missing}/${sizeOf(s)} names`;
  });
}

/**
 * The gate: fails on a gap that is not in the ledger.
 *
 * @param root The repository root.
 * @returns Whether it passed.
 */
// fallow-ignore-next-line complexity -- CLI parity-report script; not unit-tested, CRAP is coverage-estimated
export async function checkLists(root: string): Promise<boolean> {
  const baseline = await readJson<ListsBaseline>(baselinePath(root));
  if (!baseline) {
    console.log(
      "lists: baseline missing; run `deno task parity:native:refresh -- lists`. Skipped.",
    );
    return true;
  }
  const gaps = listGaps(baseline.targets, await denextListSurfaces(root));
  const known = new Set(
    ((await readJson<{ gaps: ListGap[] }>(gapsPath(root)))?.gaps ?? []).map(gapKey),
  );
  const fresh = gaps.filter((g) => !known.has(gapKey(g)));
  console.log(
    `\n== lists (props / ref methods / exports vs ${
      Object.entries(baseline.versions).map(([k, v]) => `${k} ${v}`).join(", ")
    }) ==`,
  );
  for (const line of coverage(baseline.targets, gaps)) console.log(line);
  console.log(`  known gaps: ${gaps.length - fresh.length} (baselines/lists.known-gaps.json)`);
  for (const g of fresh) console.log(`  ✗ ${g.target}: ${g.kind} \`${g.name}\` is missing`);
  return fresh.length === 0;
}

/**
 * Rewrite the known-gaps ledger from the current adapters.
 *
 * @param root The repository root.
 */
export async function writeListGaps(root: string): Promise<void> {
  const baseline = await readJson<ListsBaseline>(baselinePath(root));
  if (!baseline) throw new Error("lists baseline missing; run `parity:native:refresh -- lists`.");
  const gaps = listGaps(baseline.targets, await denextListSurfaces(root));
  await Deno.writeTextFile(
    gapsPath(root),
    JSON.stringify(
      {
        note: "Names the real lists declare that React Native mode's adapters do not provide. " +
          "Burn this down; `deno task parity:native` fails on any gap NOT listed here. " +
          "Regenerate with `deno task parity:native:gaps -- lists`.",
        gaps,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`wrote ${gaps.length} list gap(s) → ${gapsPath(root)}`);
}

// ── EXPECTED: capture (network) ────────────────────────────────────────────────────────

/** react-native-web's public instance methods of a list class. */
// fallow-ignore-next-line complexity -- CLI parity-report script; not unit-tested, CRAP is coverage-estimated
async function rnwMethods(): Promise<Record<string, string[]>> {
  // deno-lint-ignore no-import-prefix
  const ns = await import("npm:react-native-web@0.21.2") as Record<string, { prototype: object }>;
  const machinery =
    /^(constructor|render|setState|forceUpdate|isMounted|replaceState|isReactComponent|isPureReactComponent|component[A-Z]\w*)$/;
  const out: Record<string, string[]> = {};
  for (const name of ["FlatList", "SectionList", "VirtualizedList"]) {
    const names = new Set<string>();
    for (let p = ns[name].prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const k of Object.getOwnPropertyNames(p)) {
        if (!k.startsWith("_") && !machinery.test(k)) names.add(k);
      }
    }
    out[name] = [...names].sort();
  }
  return out;
}

/** Whether `node` declares an interface, a type alias or a class. */
function isTypeDeclaration(
  ts: typeof import("npm:typescript@^5"),
  node: import("npm:typescript@^5").Node,
): boolean {
  return ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
    ts.isClassDeclaration(node);
}

/**
 * Where the installed React Native declares its lists' props: the legacy hand-written `.d.ts`
 * (up to 0.87), or the generated types (`types_generated/`, 0.88 on, where the legacy list
 * declarations are gone and `VirtualizedListProps` is a type alias of its own file).
 */
function reactNativeListTypes(nm: string): { flat: string; section: string; virtualized: string } {
  const legacy = `${nm}/react-native/Libraries/Lists/FlatList.d.ts`;
  let hasLegacy = true;
  try {
    Deno.statSync(legacy);
  } catch {
    hasLegacy = false;
  }
  if (hasLegacy) {
    return {
      flat: legacy,
      section: `${nm}/react-native/Libraries/Lists/SectionList.d.ts`,
      virtualized: `${nm}/@react-native/virtualized-lists/Lists/VirtualizedList.d.ts`,
    };
  }
  const generated = `${nm}/react-native/types_generated/Libraries/Lists`;
  return {
    flat: `${generated}/FlatList.d.ts`,
    section: `${generated}/SectionList.d.ts`,
    virtualized:
      `${nm}/@react-native/virtualized-lists/types_generated/Lists/VirtualizedListProps.d.ts`,
  };
}

/** The TypeScript-side capture, run over the installed packages in `dir`. */
// fallow-ignore-next-line complexity -- CLI parity-report script; not unit-tested, CRAP is coverage-estimated
async function captureTypes(dir: string): Promise<Record<string, ListSurface>> {
  // deno-lint-ignore no-import-prefix
  const ts = (await import("npm:typescript@^5")).default;
  const nm = `${dir}/node_modules`;
  const files = {
    ...reactNativeListTypes(nm),
    flash: `${nm}/@shopify/flash-list/dist/index.d.ts`,
    flashProps: `${nm}/@shopify/flash-list/dist/FlashListProps.d.ts`,
    flashRef: `${nm}/@shopify/flash-list/dist/FlashListRef.d.ts`,
    legend: `${nm}/@legendapp/list/react-native.d.ts`,
  };
  const program = ts.createProgram(Object.values(files), {
    strict: true,
    skipLibCheck: true,
    moduleResolution: ts.ModuleResolutionKind.Node10,
  });
  const checker = program.getTypeChecker();
  /** The type a named declaration in `file` declares. */
  const typeOf = (file: string, name: string) => {
    const node = program.getSourceFile(file)!.statements.find((n) =>
      (n as { name?: { text?: string } }).name?.text === name && isTypeDeclaration(ts, n)
    );
    if (!node) throw new Error(`${name} not found in ${file}`);
    return checker.getTypeAtLocation(node);
  };
  /** Props declared by the package itself (`own`), plus SCROLL_PROPS it inherits. */
  const props = (file: string, name: string, own: RegExp) =>
    checker.getPropertiesOfType(typeOf(file, name)).filter((p) =>
      SCROLL_PROPS.includes(p.name) ||
      (p.declarations ?? []).some((d) => own.test(d.getSourceFile().fileName))
    ).map((p) => p.name).sort();
  const members = (file: string, name: string) =>
    checker.getPropertiesOfType(typeOf(file, name)).map((p) => p.name).sort();
  const valueExports = (file: string) => {
    const sym = checker.getSymbolAtLocation(program.getSourceFile(file)!)!;
    return checker.getExportsOfModule(sym).filter((s) => {
      const t = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
      return (t.flags & ts.SymbolFlags.Value) !== 0;
    }).map((s) => s.name).sort();
  };
  const rnLists = /[\\/](Libraries[\\/]Lists|virtualized-lists)[\\/]/;
  return {
    "react-native#FlatList": { props: props(files.flat, "FlatListProps", rnLists) },
    "react-native#SectionList": { props: props(files.section, "SectionListProps", rnLists) },
    "react-native#VirtualizedList": {
      props: props(files.virtualized, "VirtualizedListProps", rnLists),
    },
    "@shopify/flash-list#FlashList": {
      props: props(files.flashProps, "FlashListProps", /flash-list/),
      methods: members(files.flashRef, "FlashListRef").filter((n) => n !== "props"),
    },
    "@shopify/flash-list": { exports: valueExports(files.flash) },
    "@legendapp/list#LegendList": {
      props: props(files.legend, "LegendListProps", /@legendapp/),
      methods: members(files.legend, "LegendListRef"),
    },
    "@legendapp/list": { exports: valueExports(files.legend) },
  };
}

/**
 * Install the pinned packages, capture the EXPECTED surface and write the baseline.
 *
 * @param root The repository root.
 */
export async function refreshLists(root: string): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_parity_lists_" });
  try {
    const dependencies = {
      "react-native": PINS["react-native"],
      "@shopify/flash-list": PINS["@shopify/flash-list"],
      "@legendapp/list": PINS["@legendapp/list"],
    };
    await Deno.writeTextFile(
      `${dir}/package.json`,
      JSON.stringify({ private: true, dependencies }),
    );
    await npmInstall(dir);
    const targets = await captureTypes(dir);
    const methods = await rnwMethods();
    for (const name of ["FlatList", "SectionList", "VirtualizedList"]) {
      targets[`react-native#${name}`].methods = methods[name];
    }
    const baseline: ListsBaseline = {
      versions: PINS,
      capturedAt: new Date().toISOString(),
      targets,
    };
    await Deno.writeTextFile(baselinePath(root), JSON.stringify(baseline, null, 2) + "\n");
    console.log(
      `wrote lists baseline (${Object.keys(targets).length} targets) → ${baselinePath(root)}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}
