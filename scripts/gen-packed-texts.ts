// Generate the `*.packed.ts` modules that ship hand-written texts and data tables Brotli-compressed
// (src/build/packed-text.ts), against JSR's 20 MiB cap on the @denext/denext package:
//
//   src/ui/assets.packed.ts                        UI_CSS, UI_JS (src/ui/styles.ts, client.ts)
//   src/build/dev-server/dev-scripts.packed.ts     the dev console capture and reload scripts
//   src/build/fallow-texts.packed.ts               the `denext fallow init` texts (src/build/fallow-texts.ts)
//   src/expo/manifest-data.packed.ts               EXPO_SHIMS (src/expo/manifest-data.ts)
//   src/react-native-compat/manifest-data.packed.ts COMMUNITY_ALIASES (…/manifest-data.ts)
//
//   deno task gen:packed-texts
//
// The sources stay the hand-edited files (excluded from the publish set in deno.json); each
// generated module exports the same names with the same values, decoded once: texts when it is
// imported, data tables (plain objects) on first read, so importing them runs no Brotli.
// tests/packed-texts.test.ts fails when a committed module differs from what this writes.

import { dirname, fromFileUrl, join, relative } from "@std/path";
import { denoFmt } from "./lib/deno-fmt.ts";
import { packText } from "./lib/pack-texts.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

/** One exported value of a packed module. */
export interface PackedValue {
  /** The export's name (the same as in its source module). */
  name: string;
  /** Its JSDoc text (one paragraph). */
  doc: string;
  /** Its TypeScript type, as written in the generated module. */
  type: string;
  /** Its value: a string, or JSON-safe data (checked by a round trip). */
  value: () => Promise<unknown>;
}

/** One generated module. */
export interface PackedModule {
  /** Repo-relative path of the generated module. */
  out: string;
  /** Repo-relative paths of the hand-edited sources, for its header. */
  sources: string[];
  /** What the module carries, for its header (one sentence). */
  about: string;
  /** `import type` lines the value types need (relative to `out`). */
  typeImports?: string[];
  /** The values, in export order. */
  values: PackedValue[];
}

/** Import `path` (repo-relative) and read its export `name`. */
async function exported(path: string, name: string): Promise<unknown> {
  const mod = await import(new URL(`../${path}`, import.meta.url).href);
  if (!(name in mod)) throw new Error(`${path} does not export ${name}`);
  return mod[name];
}

/** A plain re-export of `name` from `path`. */
function reexport(path: string, name: string, doc: string, type = "string"): PackedValue {
  return { name, doc, type, value: () => exported(path, name) };
}

/** Every module this script writes. */
export const PACKED_MODULES: readonly PackedModule[] = [
  {
    out: "src/ui/assets.packed.ts",
    sources: ["src/ui/styles.ts", "src/ui/client.ts"],
    about: "the `denext ui` stylesheet and client module",
    values: [
      reexport("src/ui/styles.ts", "UI_CSS", "The stylesheet served at `/_ui/ui.css`."),
      reexport("src/ui/client.ts", "UI_JS", "The client module served at `/_ui/ui.js`."),
    ],
  },
  {
    out: "src/build/dev-server/dev-scripts.packed.ts",
    sources: [
      "src/build/dev-server/console-capture-script.ts",
      "src/build/dev-server/reload-script.ts",
    ],
    about: "the scripts every dev page runs",
    values: [
      {
        name: "DEV_CONSOLE_CAPTURE",
        doc: "The dev console capture script, forwarding to the dev server's browser-log sink " +
          "(`consoleCaptureScript(DEV_LOG_PATH)`): it heads both dev servers' reload scripts.",
        type: "string",
        value: async () => {
          const capture = await exported(
            "src/build/dev-server/console-capture-script.ts",
            "consoleCaptureScript",
          ) as (path: string) => string;
          return capture(
            await exported("src/build/dev-server/state.ts", "DEV_LOG_PATH") as string,
          );
        },
      },
      reexport(
        "src/build/dev-server/reload-script.ts",
        "DEV_RELOAD_SCRIPT",
        "The App Router dev page's inline script: the console capture, live reload / Fast " +
          "Refresh over SSE, the `__denextDev` marker and the dev error overlay.",
      ),
    ],
  },
  {
    out: "src/build/fallow-texts.packed.ts",
    sources: ["src/build/fallow-texts.ts", "scripts/coverage-to-istanbul.ts"],
    about: "the files `denext create --fallow` / `denext fallow init` write",
    values: [
      reexport(
        "src/build/fallow-texts.ts",
        "FALLOW_TOML",
        "`fallow.toml` for a denext app: the path-loaded conventions as entry points.",
      ),
      reexport(
        "src/build/fallow-texts.ts",
        "PRE_COMMIT_HOOK",
        "`.githooks/pre-commit`: the fallow gate, enabled by `deno task hooks:install`.",
      ),
      reexport(
        "src/build/fallow-texts.ts",
        "AGENTS_MD",
        'The agent instructions: denext\'s "Fallow local gate" + task map, through deno tasks.',
      ),
      {
        name: "COVERAGE_TO_ISTANBUL_SCRIPT",
        doc: "The scaffolded `scripts/coverage-to-istanbul.ts` (lcov → Istanbul map): denext's " +
          "own script, byte for byte, so a fix lands in one place.",
        type: "string",
        value: () => Deno.readTextFile(join(ROOT, "scripts/coverage-to-istanbul.ts")),
      },
    ],
  },
  {
    out: "src/expo/manifest-data.packed.ts",
    sources: ["src/expo/manifest-data.ts"],
    about: "the `expo-*` shim manifest",
    typeImports: ['import type { ExpoShim } from "./manifest.ts";'],
    values: [
      reexport(
        "src/expo/manifest-data.ts",
        "EXPO_SHIMS",
        "Every `expo-*` package React Native mode aliases, by package name. A key with a " +
          "subpath (`expo-file-system/legacy`) is a shim for that subpath of the package; its " +
          "entrypoint is the package's shim name plus the subpath " +
          "(`denext/expo/file-system/legacy`). A scoped package is shimmed per subpath only " +
          "(`@expo/ui/swift-ui` → `denext/expo/ui/swift-ui`).",
        "Readonly<Record<string, ExpoShim>>",
      ),
    ],
  },
  {
    out: "src/react-native-compat/manifest-data.packed.ts",
    sources: ["src/react-native-compat/manifest-data.ts"],
    about: "the community React Native package manifest",
    typeImports: ['import type { CommunityAlias } from "./manifest.ts";'],
    values: [
      reexport(
        "src/react-native-compat/manifest-data.ts",
        "COMMUNITY_ALIASES",
        "Every community package React Native mode aliases, by package name.",
        "Readonly<Record<string, CommunityAlias>>",
      ),
    ],
  },
];

/** `doc` as a JSDoc block, wrapped at 100 columns. */
function jsdoc(doc: string): string {
  const lines: string[] = [];
  let line = "";
  for (const word of doc.split(" ")) {
    if (line && line.length + word.length + 1 > 96) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  lines.push(line);
  return lines.length === 1 && lines[0].length <= 90
    ? `/** ${lines[0]} */`
    : `/**\n${lines.map((l) => ` * ${l}`).join("\n")}\n */`;
}

/** The value as stored: a string as is, anything else after a JSON round trip that loses nothing. */
function storable(name: string, value: unknown): unknown {
  if (typeof value === "string") return value;
  const copy = JSON.parse(JSON.stringify(value));
  if (JSON.stringify(copy) !== JSON.stringify(value) || !sameShape(value, copy)) {
    throw new Error(`${name} does not survive a JSON round trip`);
  }
  return copy;
}

/** Deep equality that notices what JSON drops (undefined values, functions). */
function sameShape(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    sameShape((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}

/**
 * The source of one generated module.
 *
 * @param mod The module's description.
 * @returns Its text, formatted as `deno fmt` writes it.
 */
export async function render(mod: PackedModule): Promise<string> {
  const values: Record<string, unknown> = {};
  for (const v of mod.values) values[v.name] = storable(v.name, await v.value());
  const packedText = relative(dirname(join(ROOT, mod.out)), join(ROOT, "src/build/packed-text.ts"))
    .replaceAll("\\", "/");
  const spec = packedText.startsWith(".") ? packedText : `./${packedText}`;
  const packed = JSON.stringify(packText(JSON.stringify(values)));
  const source = isDataModule(values)
    ? lazySource(mod, values, spec, packed)
    : eagerSource(mod, spec, packed);
  return await denoFmt(source, ROOT);
}

/** Whether every value is a plain object (a data table): those decode on first read. */
function isDataModule(values: Record<string, unknown>): boolean {
  return Object.values(values).every((v) =>
    typeof v === "object" && v !== null && !Array.isArray(v)
  );
}

/** The generated module's header, ending with how it decodes. */
function header(mod: PackedModule, decodes: string): string[] {
  return [
    "// Generated by `deno task gen:packed-texts` (scripts/gen-packed-texts.ts). Do not edit: edit",
    `// ${mod.sources.join(", ")} and regenerate.`,
    `// It carries ${mod.about} Brotli-compressed in base64 (src/build/packed-text.ts), against`,
    `// JSR's 20 MiB package cap, and decodes them once, ${decodes}.`,
    "",
  ];
}

/** A module of texts: decoded when imported. */
function eagerSource(mod: PackedModule, spec: string, packed: string): string {
  return [
    ...header(mod, "when it is imported"),
    `import { unpackText } from "${spec}";`,
    ...(mod.typeImports ?? []),
    "",
    `const PACKED: Readonly<Record<string, unknown>> = JSON.parse(unpackText(${packed}));`,
    "",
    ...mod.values.flatMap((v) => [
      jsdoc(v.doc),
      `export const ${v.name}: ${v.type} = PACKED[${JSON.stringify(v.name)}] as ${v.type};`,
      "",
    ]),
  ].join("\n");
}

/**
 * A module of data tables: each an object whose keys are written out and whose values decode on
 * the first read (`packedObject`), so importing it runs no Brotli (the packaged desktop app's
 * graph imports the React Native manifest through the config validator:
 * tests/desktop-runtime-graph.test.ts).
 */
function lazySource(
  mod: PackedModule,
  values: Record<string, unknown>,
  spec: string,
  packed: string,
): string {
  return [
    ...header(mod, "on first read, not when imported"),
    `import { lazyPack, packedObject } from "${spec}";`,
    ...(mod.typeImports ?? []),
    "",
    `const PACKED = lazyPack(${packed});`,
    "",
    ...mod.values.flatMap((v) => [
      jsdoc(v.doc),
      `export const ${v.name}: ${v.type} = packedObject<${v.type}>(PACKED, ${
        JSON.stringify(v.name)
      }, ${JSON.stringify(Object.keys(values[v.name] as object))});`,
      "",
    ]),
  ].join("\n");
}

if (import.meta.main) {
  for (const mod of PACKED_MODULES) {
    const text = await render(mod);
    await Deno.writeTextFile(join(ROOT, mod.out), text);
    console.log(`wrote ${mod.out} (${text.length} bytes)`);
  }
}
