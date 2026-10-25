// The lifecycle-script jail, as denext prepares a project for it.
//
// denext's Deno runs an approved dependency's lifecycle scripts jailed (Brainwires/deno DENEXT.md
// item 83): a scrubbed environment, a scratch HOME, writes only beneath node_modules, no network,
// every `deno` it starts clamped, and OS confinement where available. Up to runtime 3.0.0-rc.4 the
// jail is opt-in (`--jail-scripts`, `jail-scripts=true` in `.npmrc` / `npm_config_jail_scripts`,
// deno.json `"supplyChain": { "jailScripts": true }`, `paranoid`); from 3.0.0-rc.5 it is on by
// default (item 103) and `jail-scripts=false` / `"jailScripts": false` / `--no-jail-scripts` opt
// out. Where sources disagree the stricter one (on) wins, as the runtime decides.
//
// `denext migrate` / `create` / `add` find the dependencies in the built-in list
// (src/build/jail-exceptions.ts) and, when the jail will be on for the project, write the narrowest
// `supplyChain.jailScripts.packages` entries into deno.json; `denext doctor` flags a missing one
// and explains an install log's jail failures. denext never turns the jail off for the user, and
// never writes an exception where the jail is off: on an opt-in runtime an exception object would
// itself turn the jail on.

import { parse as parseJsonc } from "@std/jsonc";
import { dirname, join, relative, resolve, SEPARATOR } from "@std/path";
import toolchainPin from "./deno-toolchain-pin.json" with { type: "json" };
import { compareDenoVersions, isDenextReleaseVersion } from "./deno-version.ts";
import { stripAnsi } from "./explain/parse.ts";
import {
  JAIL_SCRIPT_EXCEPTIONS,
  type JailExceptionEntry,
  type JailPackageException,
  type JailWriteTarget,
} from "./jail-exceptions.ts";

/** The first release of denext's Deno that jails dependencies' lifecycle scripts by default. */
export const JAIL_DEFAULT_RELEASE = "3.0.0-rc.5";

/** The docs section on the jail. */
export const JAIL_DOCS_URL = "https://denext.dev/docs/toolchain#supply-chain-lifecycle-script-jail";

/**
 * Whether a release of denext's own Deno (a pin, a release manifest, the toolchain marker) jails
 * dependencies' lifecycle scripts by default: {@linkcode JAIL_DEFAULT_RELEASE} or later. Stock
 * Deno and an unknown version have no jail at all.
 *
 * @param version The runtime version (default: the checked-in toolchain pin's).
 * @returns Whether the jail is on unless the project opts out.
 */
export function jailOnByDefault(version: string | undefined = toolchainPin.version): boolean {
  return version !== undefined && isDenextReleaseVersion(version) &&
    compareDenoVersions(version, JAIL_DEFAULT_RELEASE) >= 0;
}

/** What the project's settings say: on, off, or nothing (the runtime's default). */
export type JailState = "on" | "off" | "default";

/** The project's jail settings, merged across deno.json, `.npmrc` and the environment. */
export interface JailSetting {
  /** The merged setting. */
  readonly state: JailState;
  /** Where the deciding value came from (`deno.json`, `.npmrc`, `npm_config_jail_scripts`, …). */
  readonly source?: string;
  /** deno.json's `supplyChain.jailScripts.packages`. */
  readonly packages: Readonly<Record<string, JailPackageException>>;
}

/** Where a project's jail settings are read from. */
export interface JailInputs {
  /** The parsed deno.json (or null). */
  readonly denoJson?: Record<string, unknown> | null;
  /** The project's `.npmrc` text (or null). */
  readonly npmrc?: string | null;
  /** The environment (default: none). */
  readonly env?: (name: string) => string | undefined;
}

/** A boolean `.npmrc` / environment value, or undefined. */
function boolValue(v: string | undefined): boolean | undefined {
  const s = v?.trim().toLowerCase();
  return s === "true" ? true : s === "false" ? false : undefined;
}

/** A key of `.npmrc` text (`key=value`, `;` / `#` comments), or undefined. */
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

/** An environment variable in npm's two spellings. */
function npmEnv(env: JailInputs["env"], key: string): string | undefined {
  const name = key.replace(/-/g, "_");
  return env?.(`npm_config_${name}`) ?? env?.(`NPM_CONFIG_${name.toUpperCase()}`);
}

/** A plain object, or undefined. */
function objectOf(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown>
    : undefined;
}

/**
 * The project's jail settings. Any source asking for the jail (`true`, an exceptions object,
 * `paranoid`) wins over one turning it off, as the runtime merges them.
 *
 * @param inputs deno.json, `.npmrc` and the environment.
 * @returns The merged setting.
 */
export function readJailSetting(inputs: JailInputs): JailSetting {
  const supply = objectOf(inputs.denoJson?.supplyChain);
  const jail = supply?.jailScripts;
  const packages = objectOf(objectOf(jail)?.packages) ?? {};
  const npmrc = inputs.npmrc ?? "";
  const votes: [string, boolean | undefined][] = [
    ["deno.json supplyChain.paranoid", supply?.paranoid === true ? true : undefined],
    [
      "deno.json supplyChain.jailScripts",
      typeof jail === "boolean" ? jail : objectOf(jail) ? true : undefined,
    ],
    [".npmrc paranoid", boolValue(npmrcValue(npmrc, "paranoid")) === true ? true : undefined],
    [".npmrc jail-scripts", boolValue(npmrcValue(npmrc, "jail-scripts"))],
    [
      "npm_config_paranoid",
      boolValue(npmEnv(inputs.env, "paranoid")) === true ? true : undefined,
    ],
    ["npm_config_jail_scripts", boolValue(npmEnv(inputs.env, "jail-scripts"))],
  ];
  const on = votes.find(([, v]) => v === true);
  if (on) return { state: "on", source: on[0], packages: packages as JailSetting["packages"] };
  const off = votes.find(([, v]) => v === false);
  if (off) return { state: "off", source: off[0], packages: packages as JailSetting["packages"] };
  return { state: "default", packages: packages as JailSetting["packages"] };
}

/**
 * Whether dependencies' lifecycle scripts run jailed for the project.
 *
 * @param setting The project's settings.
 * @param version The runtime version (default: the toolchain pin's).
 * @returns Whether the jail is on.
 */
export function jailEffective(setting: JailSetting, version?: string): boolean {
  return setting.state === "on" || (setting.state === "default" && jailOnByDefault(version));
}

/** The file operations the jail planning uses (`mfs` in `denext migrate`, so `--check` writes nothing). */
export interface JailFs {
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, text: string): Promise<void>;
  mkdir(path: string, options?: Deno.MkdirOptions): Promise<void>;
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean }>;
}

/** The plain filesystem. */
const DENO_FS: JailFs = {
  readTextFile: (p) => Deno.readTextFile(p),
  writeTextFile: (p, t) => Deno.writeTextFile(p, t),
  mkdir: (p, o) => Deno.mkdir(p, o),
  stat: (p) => Deno.stat(p),
};

/** A file's text, or null. */
async function readOr(fs: JailFs, path: string): Promise<string | null> {
  return await fs.readTextFile(path).catch(() => null);
}

/** A JSON(C) object file, or null. */
async function readObject(fs: JailFs, path: string): Promise<Record<string, unknown> | null> {
  const text = await readOr(fs, path);
  if (text === null) return null;
  try {
    return objectOf(parseJsonc(text)) ?? null;
  } catch {
    return null;
  }
}

/** The npm package name of a specifier (`npm:@scope/pkg@^1/sub` → `@scope/pkg`), or null. */
export function npmPackageName(spec: string): string | null {
  const m = /^npm:\/?((?:@[^/@]+\/)?[^/@]+)/.exec(spec.trim());
  return m ? m[1] : null;
}

/** The names a package.json lists in its dependency fields. */
function packageJsonDeps(pkg: Record<string, unknown> | null): string[] {
  return ["dependencies", "devDependencies", "optionalDependencies"].flatMap((field) =>
    Object.keys(objectOf(pkg?.[field]) ?? {})
  );
}

/** The npm packages a deno.json's `imports` maps to. */
function denoJsonDeps(deno: Record<string, unknown> | null): string[] {
  return Object.values(objectOf(deno?.imports) ?? {}).flatMap((v) => {
    const name = typeof v === "string" ? npmPackageName(v) : null;
    return name ? [name] : [];
  });
}

/** What the jail planning reads from a project. */
export interface JailProject {
  /** The project directory. */
  readonly dir: string;
  /** The deno.json (else deno.jsonc) path, or null when there is none. */
  readonly configPath: string | null;
  /** The parsed config, or null. */
  readonly denoJson: Record<string, unknown> | null;
  /** The parsed package.json, or null. */
  readonly packageJson: Record<string, unknown> | null;
  /** The npm packages the project depends on directly. */
  readonly deps: ReadonlySet<string>;
  /** The jail settings. */
  readonly setting: JailSetting;
}

/** Options for {@linkcode readJailProject}. */
export interface ReadJailProjectOptions {
  /** The filesystem (default: the real one). */
  readonly fs?: JailFs;
  /** The environment (default: the process's). */
  readonly env?: (name: string) => string | undefined;
  /** Consider only these packages (`denext add`'s), not the project's whole dependency list. */
  readonly deps?: readonly string[];
}

/** The process environment, never throwing. */
function processEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/**
 * Read what the jail planning needs from a project: its config, package.json, dependencies and
 * jail settings.
 *
 * @param dir The project directory.
 * @param options The filesystem, environment and an explicit dependency list.
 * @returns The project facts.
 */
export async function readJailProject(
  dir: string,
  options: ReadJailProjectOptions = {},
): Promise<JailProject> {
  const fs = options.fs ?? DENO_FS;
  let configPath: string | null = null;
  let denoJson: Record<string, unknown> | null = null;
  for (const name of ["deno.json", "deno.jsonc"]) {
    const path = join(dir, name);
    if ((await readOr(fs, path)) === null) continue;
    configPath = path;
    denoJson = await readObject(fs, path);
    break;
  }
  const packageJson = await readObject(fs, join(dir, "package.json"));
  const deps = new Set(
    options.deps ?? [...packageJsonDeps(packageJson), ...denoJsonDeps(denoJson)],
  );
  const setting = readJailSetting({
    denoJson,
    npmrc: await readOr(fs, join(dir, ".npmrc")),
    env: options.env ?? processEnv,
  });
  return { dir, configPath, denoJson, packageJson, deps, setting };
}

/** A built-in entry the project needs, with its exception resolved for the project. */
export interface JailRequirement {
  /** The built-in entry. */
  readonly entry: JailExceptionEntry;
  /** The direct dependency that brings it in. */
  readonly trigger: string;
  /** The exception to write (the entry's, plus the project directories it needs). */
  readonly exception: JailPackageException;
}

/** A path relative to the project, `/`-separated, as deno.json's `write` takes it. */
function projectRelative(dir: string, path: string): string {
  const rel = relative(dir, path).split(SEPARATOR).join("/");
  return rel === "" ? "." : rel;
}

/** The repository's hooks directory relative to `dir`, or null (no `.git` directory above it). */
async function gitHooksDir(fs: JailFs, dir: string): Promise<string | null> {
  let cur = resolve(dir);
  while (true) {
    const st = await fs.stat(join(cur, ".git")).catch(() => null);
    if (st) return st.isDirectory ? projectRelative(dir, join(cur, ".git", "hooks")) : null;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/** package.json's `msw.workerDirectory` entries. */
function mswWorkerDirs(pkg: Record<string, unknown> | null): string[] {
  const dirs = objectOf(pkg?.msw)?.workerDirectory;
  const list = Array.isArray(dirs) ? dirs : [dirs];
  return list.filter((d): d is string => typeof d === "string" && d.trim() !== "")
    .map((d) => d.trim().replace(/^\.\//, "").replace(/\/+$/, ""));
}

/** A Prisma generator `output` (`output = "../generated/client"`), per generator block. */
const PRISMA_GENERATOR = /generator\s+\w+\s*\{([^}]*)\}/g;
const PRISMA_OUTPUT = /^\s*output\s*=\s*"([^"]+)"/m;

/** Where the Prisma schema may be: package.json's `prisma.schema`, else Prisma's defaults. */
function prismaSchemaCandidates(pkg: Record<string, unknown> | null): string[] {
  const configured = objectOf(pkg?.prisma)?.schema;
  return typeof configured === "string" ? [configured] : ["prisma/schema.prisma", "schema.prisma"];
}

/** A schema's generator outputs outside node_modules, relative to `dir`. */
function generatorOutputs(text: string, schemaPath: string, dir: string): string[] {
  const out: string[] = [];
  for (const [, body] of text.matchAll(PRISMA_GENERATOR)) {
    const output = PRISMA_OUTPUT.exec(body)?.[1];
    if (!output) continue;
    const rel = projectRelative(dir, resolve(dirname(schemaPath), output));
    if (!/(^|\/)node_modules(\/|$)/.test(rel)) out.push(rel);
  }
  return out;
}

/** The Prisma schema's generator outputs outside node_modules, relative to `dir`. */
async function prismaOutputs(
  fs: JailFs,
  dir: string,
  pkg: Record<string, unknown> | null,
): Promise<string[]> {
  for (const candidate of prismaSchemaCandidates(pkg)) {
    const path = resolve(dir, candidate);
    const text = await readOr(fs, path);
    if (text !== null) return generatorOutputs(text, path, dir);
  }
  return [];
}

/** The project directories one write target names. */
async function writeTargetDirs(
  fs: JailFs,
  project: JailProject,
  target: JailWriteTarget,
): Promise<string[]> {
  if (target === "msw-worker") return mswWorkerDirs(project.packageJson);
  if (target === "prisma-output") return await prismaOutputs(fs, project.dir, project.packageJson);
  const hooks = await gitHooksDir(fs, project.dir);
  return hooks ? [hooks] : [];
}

/** The entry's exception with its write targets resolved, or null when it needs nothing. */
async function resolvedException(
  fs: JailFs,
  project: JailProject,
  entry: JailExceptionEntry,
): Promise<JailPackageException | null> {
  const write = [...entry.exception.write ?? []];
  for (const target of entry.writeTargets ?? []) {
    write.push(...await writeTargetDirs(fs, project, target));
  }
  const unique = [...new Set(write)];
  const exception: JailPackageException = {
    ...(entry.exception.env?.length ? { env: [...entry.exception.env] } : {}),
    ...(unique.length ? { write: unique } : {}),
    ...(entry.exception.net ? { net: true } : {}),
  };
  return Object.keys(exception).length ? exception : null;
}

/**
 * The built-in exceptions the project's dependencies need, resolved for the project.
 *
 * @param project The project facts ({@linkcode readJailProject}).
 * @param fs The filesystem (default: the real one).
 * @returns One requirement per package, in the list's order.
 */
export async function requiredJailExceptions(
  project: JailProject,
  fs: JailFs = DENO_FS,
): Promise<JailRequirement[]> {
  const out: JailRequirement[] = [];
  for (const entry of JAIL_SCRIPT_EXCEPTIONS) {
    const trigger = [entry.name, ...entry.via ?? []].find((n) => project.deps.has(n));
    if (!trigger) continue;
    const exception = await resolvedException(fs, project, entry);
    if (exception) out.push({ entry, trigger, exception });
  }
  return out;
}

/** What {@linkcode applyJailExceptions} did. */
export type JailAction =
  /** No dependency in the built-in list. */
  | "none"
  /** The project turned the jail off; nothing written. */
  | "off"
  /** The jail is not on for this runtime yet; nothing written. */
  | "pending"
  /** Every needed exception is already configured. */
  | "configured"
  /** The exceptions were written into deno.json. */
  | "written"
  /** They must be added by hand (no deno.json, a hand-authored one migrate keeps, or an edit refused). */
  | "manual";

/** The outcome of {@linkcode applyJailExceptions}. */
export interface JailReport {
  readonly action: JailAction;
  /** Whether the jail is on for the project. */
  readonly effective: boolean;
  /** The packages that need an exception. */
  readonly required: readonly JailRequirement[];
  /** Those without one configured. */
  readonly missing: readonly JailRequirement[];
  /** The config file written (action `written`). */
  readonly configPath?: string;
  /** The `supplyChain` JSON to add by hand (action `manual`). */
  readonly snippet?: string;
  /** What to tell the user, one line each. */
  readonly lines: readonly string[];
}

/** Options for {@linkcode applyJailExceptions}. */
export interface ApplyJailOptions extends ReadJailProjectOptions {
  /** Whether deno.json may be edited (false: report the snippet instead). Default true. */
  readonly edit?: boolean;
  /** The runtime version the project installs with (default: the toolchain pin's). */
  readonly version?: string;
}

/** `a, b and c`. */
function names(reqs: readonly JailRequirement[]): string {
  const list = reqs.map((r) => r.entry.name);
  return list.length < 2
    ? list.join("")
    : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** The deno.json `supplyChain` value for the missing exceptions. */
export function jailSnippet(missing: readonly JailRequirement[]): string {
  const packages = Object.fromEntries(missing.map((r) => [r.entry.name, r.exception]));
  return JSON.stringify({ supplyChain: { jailScripts: { packages } } }, null, 2);
}

/** One line per requirement: the package, why, and what the exception cannot fix. */
function requirementLines(reqs: readonly JailRequirement[]): string[] {
  return reqs.flatMap((r) => [
    `${r.entry.name}${r.trigger === r.entry.name ? "" : ` (via ${r.trigger})`}: ${r.entry.reason}`,
    ...(r.entry.caveat ? [`  ${r.entry.caveat}`] : []),
  ]);
}

/** Write the missing exceptions into the config text; null when the edit is refused. */
async function editedConfig(
  text: string,
  doc: Record<string, unknown> | null,
  missing: readonly JailRequirement[],
): Promise<string | null> {
  // swc-backed and comment-preserving: loaded only when there is something to write
  const { setJsonValue } = await import("./json-edit.ts");
  const jail = objectOf(objectOf(doc?.supplyChain)?.jailScripts);
  if (!jail) {
    const packages = Object.fromEntries(missing.map((r) => [r.entry.name, r.exception]));
    const edit = await setJsonValue(text, ["supplyChain", "jailScripts"], { packages });
    return edit.ok ? edit.source : null;
  }
  let source = text;
  for (const r of missing) {
    const edit = await setJsonValue(
      source,
      ["supplyChain", "jailScripts", "packages", r.entry.name],
      r.exception,
    );
    if (!edit.ok) return null;
    source = edit.source;
  }
  return source;
}

/** Create the project directories an exception's `write` grants (Linux's Landlock skips a missing one). */
async function ensureWriteDirs(
  fs: JailFs,
  dir: string,
  missing: readonly JailRequirement[],
): Promise<void> {
  for (const r of missing) {
    for (const w of r.exception.write ?? []) {
      if (w.startsWith("..")) continue;
      await fs.mkdir(join(dir, w), { recursive: true }).catch(() => {});
    }
  }
}

/**
 * Find the project's dependencies that need a lifecycle-script jail exception and, when the jail
 * is on for the project, write the missing ones into its deno.json (comments and key order
 * kept). Nothing is written when the jail is off (the project opted out, or the runtime jails
 * only on request), and the jail is never turned off.
 *
 * @param dir The project directory.
 * @param options The filesystem, environment, runtime version, dependency list and whether the
 *   config may be edited.
 * @returns What was found and done.
 */
export async function applyJailExceptions(
  dir: string,
  options: ApplyJailOptions = {},
): Promise<JailReport> {
  const fs = options.fs ?? DENO_FS;
  const project = await readJailProject(dir, options);
  const required = await requiredJailExceptions(project, fs);
  const effective = jailEffective(project.setting, options.version);
  const missing = required.filter((r) => !Object.hasOwn(project.setting.packages, r.entry.name));
  const base = { effective, required, missing };
  if (required.length === 0) return { ...base, action: "none", lines: [] };
  if (project.setting.state === "off") {
    return {
      ...base,
      action: "off",
      lines: [
        `lifecycle scripts are not jailed here (${project.setting.source} turns the jail off); ` +
        `${names(required)} would need an exception under it`,
      ],
    };
  }
  if (!effective) {
    return {
      ...base,
      action: "pending",
      lines: [
        `${names(required)} will need a lifecycle-script jail exception once dependencies' ` +
        `install scripts run jailed (on by default from denext's runtime ${JAIL_DEFAULT_RELEASE}, ` +
        "or with jail-scripts=true); `denext doctor` flags it then",
      ],
    };
  }
  if (missing.length === 0) {
    return {
      ...base,
      action: "configured",
      lines: [`lifecycle-script jail exceptions already configured for ${names(required)}`],
    };
  }
  const written = options.edit === false || project.configPath === null ? null : await editedConfig(
    await fs.readTextFile(project.configPath),
    project.denoJson,
    missing,
  );
  if (written === null) {
    const snippet = jailSnippet(missing);
    return {
      ...base,
      action: "manual",
      snippet,
      lines: [
        `${names(missing)} need${missing.length === 1 ? "s" : ""} a lifecycle-script jail ` +
        "exception; add this to deno.json (" + JAIL_DOCS_URL + "):",
        ...snippet.split("\n").map((l) => `  ${l}`),
        ...requirementLines(missing),
      ],
    };
  }
  await fs.writeTextFile(project.configPath!, written);
  await ensureWriteDirs(fs, dir, missing);
  return {
    ...base,
    action: "written",
    configPath: project.configPath!,
    lines: [
      `deno.json: supplyChain.jailScripts exception${missing.length === 1 ? "" : "s"} for ` +
      `${names(missing)} (their install scripts need more than the lifecycle-script jail allows; ` +
      "the jail stays on)",
      ...requirementLines(missing),
    ],
  };
}

/** What a jail stopped, read from the failure's output. */
export type JailSign = "net" | "write" | "npm" | "deno";

/** One dependency's lifecycle script that failed in an install log. */
export interface JailFailure {
  /** The npm package. */
  readonly name: string;
  /** Its version. */
  readonly version: string;
  /** The script (`postinstall`, …). */
  readonly script: string;
  /** Its exit code. */
  readonly exitCode: number;
  /** What the jail visibly stopped (empty: nothing recognisable). */
  readonly signs: readonly JailSign[];
  /** The built-in entry for the package, when it has one. */
  readonly entry?: JailExceptionEntry;
}

/** Deno's line for a dependency's failed lifecycle script. */
const FAILED_SCRIPT =
  /error: script '([^']+)' in '((?:@[^@'/]+\/)?[^@']+)@([^']+)' failed with exit code (\d+)/g;

/** The jail's own messages and the errors a confined script meets, by what they mean. */
const SIGNS: readonly [JailSign, RegExp][] = [
  ["npm", /running a real np[mx] is not allowed in a jailed npm lifecycle script/],
  ["deno", /deno subcommand is not allowed in a jailed npm lifecycle script/],
  [
    "net",
    /Requires (?:net|import) access|NotCapable[^\n]*\bnet\b|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|fetch failed/i,
  ],
  [
    "write",
    /Requires write access|NotCapable[^\n]*\bwrite\b|EACCES|EPERM|EROFS|Operation not permitted|permission denied|read-only file system/i,
  ],
];

/**
 * The dependencies' failed lifecycle scripts in an install's output (Deno's `error: script
 * '<script>' in '<name>@<version>' failed with exit code <n>` and the output it prints with it),
 * each with what the jail visibly stopped.
 *
 * @param output What `deno install` / `add` / `ci` printed.
 * @returns The failures, in order.
 */
export function jailFailures(output: string): JailFailure[] {
  const text = stripAnsi(output);
  const matches = [...text.matchAll(FAILED_SCRIPT)];
  return matches.map((m, i) => {
    const block = text.slice(m.index, matches[i + 1]?.index ?? text.length);
    const entry = JAIL_SCRIPT_EXCEPTIONS.find((e) => e.name === m[2]);
    return {
      name: m[2],
      version: m[3],
      script: m[1],
      exitCode: Number(m[4]),
      signs: SIGNS.filter(([, re]) => re.test(block)).map(([sign]) => sign),
      ...(entry ? { entry } : {}),
    };
  });
}

/** The exception a failure points at: the built-in one, else one inferred from its signs. */
function suggestedException(f: JailFailure): JailPackageException | null {
  if (f.entry) return f.entry.exception;
  if (f.signs.includes("net")) return { net: true };
  return null;
}

/**
 * Explain an install log's failed lifecycle scripts as jail failures: which package, what the
 * jail stopped, and the exception to add (or why none helps). Failures with no sign of the jail
 * and no built-in entry are left out.
 *
 * @param failures From {@linkcode jailFailures}.
 * @returns One block of lines per failure the jail explains.
 */
export function explainJailFailures(failures: readonly JailFailure[]): string[] {
  const out: string[] = [];
  for (const f of failures) {
    if (f.signs.length === 0 && !f.entry) continue;
    const stopped = f.signs.length
      ? f.signs.map((s) =>
        s === "net"
          ? "the network"
          : s === "write"
          ? "a write outside node_modules"
          : s === "npm"
          ? "a real npm / npx"
          : "an installing deno subcommand"
      ).join(", ")
      : "nothing recognisable, but it is in denext's list";
    out.push(
      `${f.name}@${f.version}'s ${f.script} script failed in the lifecycle-script jail ` +
        `(stopped: ${stopped})`,
    );
    if (f.entry) out.push(`  ${f.entry.reason}`);
    const exception = suggestedException(f);
    if (exception) {
      out.push(
        `  fix: deno.json "supplyChain": { "jailScripts": { "packages": { "${f.name}": ${
          JSON.stringify(exception)
        } } } }`,
      );
    } else if (f.signs.includes("write")) {
      out.push(
        `  fix: list the directory it writes under "supplyChain.jailScripts.packages.${f.name}` +
          '.write" in deno.json',
      );
    } else {
      out.push(
        "  a real npm / npx or an installing deno subcommand is never allowed in the jail: " +
          "run that step yourself after the install",
      );
    }
    if (f.entry?.caveat) out.push(`  ${f.entry.caveat}`);
  }
  return out;
}
