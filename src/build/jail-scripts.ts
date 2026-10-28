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
import { dirname, isAbsolute, join, relative, resolve, SEPARATOR } from "@std/path";
import toolchainPin from "./deno-toolchain-pin.json" with { type: "json" };
import {
  compareDenoVersions,
  currentDenoIdentity,
  type DenoIdentity,
  isDenextDenoVersion,
  isDenextReleaseVersion,
  parseDenoVersionOutput,
} from "./deno-version.ts";
import { stripAnsi } from "./explain/parse.ts";
import { npmWorkspaceOf, workspaceOf } from "./workspace-imports.ts";
import { npmrcValue } from "./npmrc-supply-chain.ts";
import {
  JAIL_SCRIPT_EXCEPTIONS,
  type JailExceptionEntry,
  type JailPackageException,
  type JailWriteTarget,
} from "./jail-exceptions.ts";
import { runToExit } from "./exited-output.ts";

export { npmrcValue };

/** The first release of denext's Deno that jails dependencies' lifecycle scripts by default. */
export const JAIL_DEFAULT_RELEASE = "3.0.0-rc.5";

/**
 * The first release of denext's Deno that takes a per-package host list (`"net": ["host"]`) and
 * `~`-relative `write` paths in `jailScripts.packages` (DENEXT.md item 108). On older runtimes a
 * host list is a config error and `~` a literal directory name, so neither is written there.
 */
const JAIL_HOSTS_RELEASE = "3.0.0-rc.6";

/**
 * Whether a release of denext's own Deno takes per-package host lists and `~` write paths.
 *
 * @param version The runtime version (default: the checked-in toolchain pin's).
 * @returns Whether {@linkcode JAIL_HOSTS_RELEASE} or later.
 */
export function jailHostListsSupported(
  version: string | null | undefined = toolchainPin.version,
): boolean {
  return version != null && isDenextReleaseVersion(version) &&
    compareDenoVersions(version, JAIL_HOSTS_RELEASE) >= 0;
}

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
export function jailOnByDefault(
  version: string | null | undefined = toolchainPin.version,
): boolean {
  return version != null && isDenextReleaseVersion(version) &&
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
  /** Where `paranoid` is turned on, when it is (it refuses scripts the OS can't confine). */
  readonly paranoid?: string;
}

/** Where a project's jail settings are read from. */
export interface JailInputs {
  /** The parsed deno.json (or null). */
  readonly denoJson?: Record<string, unknown> | null;
  /** The project's `.npmrc` text (or null). */
  readonly npmrc?: string | null;
  /** The user-level `.npmrc` text (`~/.npmrc`, or npm's `userconfig`), or null. */
  readonly userNpmrc?: string | null;
  /** The environment (default: none). */
  readonly env?: (name: string) => string | undefined;
}

/** A boolean `.npmrc` / environment value, or undefined. */
function boolValue(v: string | undefined): boolean | undefined {
  const s = v?.trim().toLowerCase();
  return s === "true" ? true : s === "false" ? false : undefined;
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
    // The user-level file: the runtime reads it too (after the project's).
    [
      "~/.npmrc paranoid",
      boolValue(npmrcValue(inputs.userNpmrc ?? "", "paranoid")) === true ? true : undefined,
    ],
    ["~/.npmrc jail-scripts", boolValue(npmrcValue(inputs.userNpmrc ?? "", "jail-scripts"))],
    [
      "npm_config_paranoid",
      boolValue(npmEnv(inputs.env, "paranoid")) === true ? true : undefined,
    ],
    ["npm_config_jail_scripts", boolValue(npmEnv(inputs.env, "jail-scripts"))],
  ];
  const pkgs = packages as JailSetting["packages"];
  const paranoid = votes.find(([name, v]) => v === true && name.includes("paranoid"))?.[0];
  const extra = paranoid ? { paranoid } : {};
  const on = votes.find(([, v]) => v === true);
  if (on) return { state: "on", source: on[0], packages: pkgs, ...extra };
  const off = votes.find(([, v]) => v === false);
  if (off) return { state: "off", source: off[0], packages: pkgs, ...extra };
  return { state: "default", packages: pkgs, ...extra };
}

/**
 * Whether dependencies' lifecycle scripts run jailed for the project.
 *
 * @param setting The project's settings.
 * @param version The runtime version (default: the toolchain pin's).
 * @returns Whether the jail is on.
 */
export function jailEffective(setting: JailSetting, version?: string | null): boolean {
  if (version === null) return false; // a Deno with no jail (stock) runs every script unconfined
  return setting.state === "on" || (setting.state === "default" && jailOnByDefault(version));
}

/** The runtime a project's installs run on, as the jail planning reads it. */
export interface JailRuntime {
  /**
   * Its version for the planning: the pin's, another release of denext's Deno, or `null` for a
   * Deno with no lifecycle-script jail at all (stock Deno).
   */
  readonly version: string | null;
  /** Which runtime it is, for messages. */
  readonly label: string;
  /** Whether it is not the pinned toolchain (`DENEXT_DENO=stock` / `<path>`, a `DENO_BIN`). */
  readonly overridden: boolean;
}

/** Seams for {@linkcode jailRuntime}; each defaults to this process. */
export interface JailRuntimeSeams {
  /** The `deno` that installs run on (default: `denoExecutable()`). */
  readonly executable?: () => string | Promise<string>;
  /** This process's binary and identity (default: `Deno.execPath()`, its `Deno.build`). */
  readonly current?: { readonly path: string; readonly identity: DenoIdentity };
  /** `<bin> --version`'s output, or null when it can't be run. */
  readonly versionOutput?: (bin: string) => Promise<string | null>;
  /** The pinned toolchain version (default: the checked-in pin's). */
  readonly pinned?: string | null;
}

/** `<bin> --version`'s output, or null (not runnable, or no answer within 10 s). */
async function denoVersionOutput(bin: string): Promise<string | null> {
  try {
    const out = await runToExit(bin, {
      args: ["--version"],
      stderr: "null",
      signal: AbortSignal.timeout(10_000),
    });
    return out.success ? new TextDecoder().decode(out.stdout) : null;
  } catch {
    return null;
  }
}

/**
 * The runtime the project's installs run on (the `deno` denext spawns for them: denext's
 * toolchain, or what `DENEXT_DENO=stock` / `<path>` or `DENO_BIN` chose), so the jail is
 * planned for it rather than for the pin: a stock Deno has no jail, and another release of
 * denext's Deno may jail by default, or take host lists, where the pin does not. A binary whose
 * version can't be read is planned for as the pin.
 *
 * @param seams The executable, this process and the version probe (tests).
 * @returns The runtime.
 */
export async function jailRuntime(seams: JailRuntimeSeams = {}): Promise<JailRuntime> {
  const pinned = seams.pinned !== undefined ? seams.pinned : toolchainPin.version;
  const bin = await (seams.executable ??
    (async () => (await import("./deno-executable.ts")).denoExecutable()))();
  const current = seams.current ?? { path: Deno.execPath(), identity: currentDenoIdentity() };
  const identity = bin === current.path
    ? current.identity
    : parseDenoVersionOutput(await (seams.versionOutput ?? denoVersionOutput)(bin) ?? "");
  if (identity === null) {
    return {
      version: pinned,
      label: `the Deno at ${bin} (its version could not be read; planned for the pin ${pinned})`,
      overridden: true,
    };
  }
  if (!isDenextDenoVersion(identity, pinned)) {
    return {
      version: null,
      label: `stock Deno ${identity.deno} at ${bin}, which has no lifecycle-script jail`,
      overridden: true,
    };
  }
  const version = identity.denext ?? identity.deno;
  return version === pinned
    ? { version, label: `denext's runtime ${version} (the pin)`, overridden: false }
    : {
      version,
      label: `denext's runtime ${version} at ${bin} (the pin is ${pinned})`,
      overridden: true,
    };
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

/**
 * The plain filesystem, with every write and directory creation confined to the project at
 * `root` (`denext add` / `create` / `upgrade` run on projects they did not write: a committed
 * symlink must not carry the deno.json edit, or a granted directory, out of it).
 */
function confinedFs(root: string): JailFs {
  const inside = async (path: string) => {
    const { assertInsideProject } = await import("./project-confine.ts");
    await assertInsideProject(root, path);
  };
  return {
    ...DENO_FS,
    writeTextFile: async (p, t) => {
      await inside(p);
      await DENO_FS.writeTextFile(p, t);
    },
    mkdir: async (p, o) => {
      await inside(p);
      await DENO_FS.mkdir(p, o);
    },
  };
}

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
  /**
   * The directory whose deno.json holds `supplyChain`: the Deno workspace's root when the project
   * is a member (the runtime reads `supplyChain` from the root alone), else the project itself.
   * `write` paths are relative to it.
   */
  readonly dir: string;
  /** The directory the command ran on (a workspace member, or {@linkcode dir} itself). */
  readonly appDir: string;
  /** Every package directory the root installs for: the root, then each workspace member. */
  readonly packageDirs: readonly string[];
  /**
   * A workspace member's own config that sets `supplyChain`, which the runtime ignores (with a
   * warning) — null when there is none.
   */
  readonly ignoredMemberConfig: string | null;
  /** The deno.json (else deno.jsonc) path, or null when there is none. */
  readonly configPath: string | null;
  /** The parsed config, or null. */
  readonly denoJson: Record<string, unknown> | null;
  /** The parsed package.json, or null. */
  readonly packageJson: Record<string, unknown> | null;
  /** Each package directory's parsed package.json (null when it has none), by directory. */
  readonly packageJsons: ReadonlyMap<string, Record<string, unknown> | null>;
  /** The npm packages the project (every workspace member included) depends on directly. */
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
 * Where the user-level `.npmrc` is: npm's `userconfig` setting from the environment, else
 * `.npmrc` in the home directory (`HOME`, or `USERPROFILE` on Windows); null with neither.
 *
 * @param env The environment.
 * @returns The path, or null.
 */
export function userNpmrcPath(env: (name: string) => string | undefined): string | null {
  const configured = npmEnv(env, "userconfig");
  if (configured) return configured;
  const home = env("HOME") ?? env("USERPROFILE");
  return home ? join(home, ".npmrc") : null;
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
  const appDir = resolve(dir);
  // A deno.json `workspace`, else an npm one (package.json `workspaces`): Deno installs for every
  // member of either, so each member's dependencies can bring in a listed package.
  const ws = await workspaceOf(appDir).catch(() => null) ??
    await npmWorkspaceOf(appDir).catch(() => null);
  const root = ws?.root ?? appDir;
  const { configPath, denoJson } = await configIn(fs, root);
  const packageDirs = [root, ...(ws?.members ?? []).filter((m) => m !== root)];
  const packageJsons = new Map<string, Record<string, unknown> | null>();
  const allDeps: string[] = [];
  for (const pkgDir of packageDirs) {
    const pkg = await readObject(fs, join(pkgDir, "package.json"));
    packageJsons.set(pkgDir, pkg);
    const config = pkgDir === root ? denoJson : (await configIn(fs, pkgDir)).denoJson;
    allDeps.push(...packageJsonDeps(pkg), ...denoJsonDeps(config));
  }
  const own = appDir === root ? null : await configIn(fs, appDir);
  const ignoredMemberConfig = own?.denoJson?.supplyChain !== undefined ? own.configPath : null;
  const env = options.env ?? processEnv;
  const userNpmrc = userNpmrcPath(env);
  const setting = readJailSetting({
    denoJson,
    npmrc: await readOr(fs, join(root, ".npmrc")),
    userNpmrc: userNpmrc === null ? null : await readOr(fs, userNpmrc),
    env,
  });
  return {
    dir: root,
    appDir,
    packageDirs,
    ignoredMemberConfig,
    configPath,
    denoJson,
    packageJson: packageJsons.get(root) ?? null,
    packageJsons,
    deps: new Set(options.deps ?? allDeps),
    setting,
  };
}

/** The deno.json (else deno.jsonc) in `dir` and its object (null for each when absent). */
async function configIn(
  fs: JailFs,
  dir: string,
): Promise<{ configPath: string | null; denoJson: Record<string, unknown> | null }> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const path = join(dir, name);
    if ((await readOr(fs, path)) === null) continue;
    return { configPath: path, denoJson: await readObject(fs, path) };
  }
  return { configPath: null, denoJson: null };
}

/** A built-in entry the project needs, with its exception resolved for the project. */
export interface JailRequirement {
  /** The built-in entry. */
  readonly entry: JailExceptionEntry;
  /** The direct dependency that brings it in. */
  readonly trigger: string;
  /** The exception to write (the entry's, plus the project directories it needs). */
  readonly exception: JailPackageException;
  /**
   * Project directories the entry would write that were left out because they are not narrow:
   * an absolute path, or the project itself or a directory above it (`.`, `..`).
   */
  readonly refused?: readonly string[];
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

/** package.json's `msw.workerDirectory` entries, relative to `root` (the package is in `pkgDir`). */
function mswWorkerDirs(
  pkg: Record<string, unknown> | null,
  pkgDir: string,
  root: string,
): string[] {
  const dirs = objectOf(pkg?.msw)?.workerDirectory;
  const list = Array.isArray(dirs) ? dirs : [dirs];
  return list.filter((d): d is string => typeof d === "string" && d.trim() !== "")
    .map((d) => projectRelative(root, resolve(pkgDir, d.trim())));
}

/** The repository's hooks directory above the project: only `..` segments, then `.git/hooks`. */
const GIT_HOOKS_ABOVE = /^(?:\.\.\/)*\.git\/hooks$/;

/**
 * Whether a resolved `write` directory is narrow enough to grant on the project's behalf: not
 * empty, not absolute (another drive on Windows), inside the project (no `..` segment: a
 * Prisma `output` or msw `workerDirectory` pointing out of it is refused), and not the project
 * itself — a grant that covers the whole project (or more) would undo the jail. The one target
 * allowed above the project is the repository's `.git/hooks` (`git-hooks`).
 *
 * @param rel The directory, relative to the project (`/`-separated).
 * @param target The write target it came from.
 * @returns Whether it may be granted.
 */
export function narrowWriteTarget(rel: string, target?: JailWriteTarget): boolean {
  if (rel.trim() === "" || isAbsolute(rel) || /^(?:[A-Za-z]:|[\\/])/.test(rel)) {
    return false;
  }
  const segments = rel.split(/[\\/]/);
  if (segments.includes("..")) return target === "git-hooks" && GIT_HOOKS_ABOVE.test(rel);
  return !segments.every((seg) => seg === "." || seg === "");
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

/** The Prisma schema's generator outputs outside node_modules, relative to `root`. */
async function prismaOutputs(
  fs: JailFs,
  pkgDir: string,
  root: string,
  pkg: Record<string, unknown> | null,
): Promise<string[]> {
  for (const candidate of prismaSchemaCandidates(pkg)) {
    const path = resolve(pkgDir, candidate);
    const text = await readOr(fs, path);
    if (text !== null) return generatorOutputs(text, path, root);
  }
  return [];
}

/** The project directories one write target names. */
async function writeTargetDirs(
  fs: JailFs,
  project: JailProject,
  target: JailWriteTarget,
): Promise<string[]> {
  if (target === "git-hooks") {
    const hooks = await gitHooksDir(fs, project.dir);
    return hooks ? [hooks] : [];
  }
  const out: string[] = [];
  for (const pkgDir of project.packageDirs) {
    const pkg = project.packageJsons.get(pkgDir) ?? null;
    out.push(
      ...target === "msw-worker"
        ? mswWorkerDirs(pkg, pkgDir, project.dir)
        : await prismaOutputs(fs, pkgDir, project.dir, pkg),
    );
  }
  return out;
}

/**
 * A built-in entry's exception for a runtime, before its project directories: the host list and
 * the `~` download cache where the runtime takes them (DENEXT.md item 108), else `net: true`.
 *
 * @param entry The built-in entry.
 * @param version The runtime version (default: the toolchain pin's).
 * @returns The exception.
 */
export function entryException(
  entry: JailExceptionEntry,
  version?: string | null,
): JailPackageException {
  const hostLists = jailHostListsSupported(version);
  const cache = hostLists ? entry.cache : undefined;
  const write = [...new Set([...entry.exception.write ?? [], ...cache ? [cache.path] : []])];
  const env = [...new Set([...entry.exception.env ?? [], ...cache ? [cache.env] : []])].sort();
  const net = !entry.exception.net
    ? undefined
    : hostLists && entry.hosts?.length
    ? [...new Set(entry.hosts)].sort()
    : true;
  return {
    ...(env.length ? { env } : {}),
    ...(write.length ? { write } : {}),
    ...(net !== undefined ? { net } : {}),
  };
}

/** The project directories an entry's write targets name: those to grant, and those refused. */
async function entryWriteDirs(
  fs: JailFs,
  project: JailProject,
  entry: JailExceptionEntry,
): Promise<{ granted: string[]; refused: string[] }> {
  const granted: string[] = [];
  const refused = new Set<string>();
  for (const target of entry.writeTargets ?? []) {
    for (const dir of await writeTargetDirs(fs, project, target)) {
      if (narrowWriteTarget(dir, target)) granted.push(dir);
      else refused.add(dir);
    }
  }
  return { granted, refused: [...refused] };
}

/**
 * The entry's exception for the runtime with its project directories resolved, and the
 * directories left out as too broad; the exception is null when it needs nothing.
 */
async function resolvedException(
  fs: JailFs,
  project: JailProject,
  entry: JailExceptionEntry,
  version: string | null | undefined,
): Promise<{ exception: JailPackageException | null; refused: string[] }> {
  const { granted, refused } = await entryWriteDirs(fs, project, entry);
  const base = entryException(entry, version);
  const write = [...new Set([...base.write ?? [], ...granted])];
  const exception: JailPackageException = {
    ...(base.env ? { env: base.env } : {}),
    ...(write.length ? { write } : {}),
    ...(base.net !== undefined ? { net: base.net } : {}),
  };
  return { exception: Object.keys(exception).length ? exception : null, refused };
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
  version?: string | null,
): Promise<JailRequirement[]> {
  const out: JailRequirement[] = [];
  for (const entry of JAIL_SCRIPT_EXCEPTIONS) {
    const trigger = [entry.name, ...entry.via ?? []].find((n) => project.deps.has(n));
    if (!trigger) continue;
    const { exception, refused } = await resolvedException(fs, project, entry, version);
    if (exception) out.push({ entry, trigger, exception, ...refused.length ? { refused } : {} });
    else if (refused.length) out.push({ entry, trigger, exception: {}, refused });
  }
  return out;
}

/** Whether a requirement has anything to write (one whose every directory was refused has not). */
export function grantsSomething(r: JailRequirement): boolean {
  return Object.keys(r.exception).length > 0;
}

/** The lines saying which too-broad directories were left out of the exceptions. */
function refusedLines(reqs: readonly JailRequirement[]): string[] {
  return reqs.filter((r) => r.refused?.length).map((r) =>
    `${r.entry.name}: not granting write to ${
      r.refused!.map((w) => `"${w}"`).join(", ")
    } (the whole project, outside it, or another drive); list the narrower directory it needs ` +
    `under its "write" by hand`
  );
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
  /** That file's text before the write (action `written`), to put back when the install fails. */
  readonly before?: string;
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
  readonly version?: string | null;
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
  return reqs.filter(grantsSomething).flatMap((r) => [
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
      // `~` is the runtime's (it creates those itself); above the project is not ours to create
      if (w.startsWith("..") || w.startsWith("~")) continue;
      await fs.mkdir(join(dir, w), { recursive: true }).catch(() => {});
    }
  }
}

/** The fields every {@linkcode JailReport} shares. */
type JailReportBase = Pick<JailReport, "effective" | "required" | "missing">;

/**
 * The report when nothing is to be written: no listed dependency, the jail off or not yet on, or
 * every exception already configured. Null when some exception is missing.
 */
function unwrittenReport(
  base: JailReportBase,
  setting: JailSetting,
  refused: readonly string[],
): JailReport | null {
  const { effective, required, missing } = base;
  if (required.length === 0) {
    const say = effective && refused.length > 0;
    return { ...base, action: say ? "manual" : "none", lines: say ? [...refused] : [] };
  }
  if (setting.state === "off") {
    return {
      ...base,
      action: "off",
      lines: [
        `lifecycle scripts are not jailed here (${setting.source} turns the jail off); ` +
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
  if (missing.length > 0) return null;
  return {
    ...base,
    action: "configured",
    lines: [
      `lifecycle-script jail exceptions already configured for ${names(required)}`,
      ...refused,
    ],
  };
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
  // Writes stay inside the project (an injected fs, `migrate`'s, confines its own).
  const out = options.fs ?? confinedFs(project.dir);
  const all = await requiredJailExceptions(project, fs, options.version);
  const refused = refusedLines(all);
  const required = all.filter(grantsSomething);
  const effective = jailEffective(project.setting, options.version);
  const missing = required.filter((r) => !Object.hasOwn(project.setting.packages, r.entry.name));
  const base = { effective, required, missing };
  const early = unwrittenReport(base, project.setting, refused);
  if (early) return early;
  const before = project.configPath === null ? "" : await fs.readTextFile(project.configPath);
  const written = options.edit === false || project.configPath === null
    ? null
    : await editedConfig(before, project.denoJson, missing);
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
        ...refused,
      ],
    };
  }
  await out.writeTextFile(project.configPath!, written);
  await ensureWriteDirs(out, project.dir, missing);
  return {
    ...base,
    action: "written",
    configPath: project.configPath!,
    before,
    lines: [
      `deno.json: supplyChain.jailScripts exception${missing.length === 1 ? "" : "s"} for ` +
      `${names(missing)} (their install scripts need more than the lifecycle-script jail allows; ` +
      "the jail stays on)",
      ...requirementLines(missing),
      ...refused,
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
  /**
   * The host names the script's output shows it failing to reach (sorted, each a plain
   * `name.tld`, lower-cased, no port); empty when it shows none.
   */
  readonly hosts: readonly string[];
}

/** Deno's line for a dependency's failed lifecycle script. */
const FAILED_SCRIPT =
  /error: script '([^'\s]+)' in '((?:@[^@'/\s]+\/)?[^@'\s]+)@([^'\s]+)' failed with exit code (\d+)/g;

/**
 * The jail's own messages and Deno's permission clamp, by what they mean: what every `deno` in
 * the jail says on every OS.
 */
const CLAMP_SIGNS: readonly [JailSign, RegExp][] = [
  ["npm", /running a real np[mx] is not allowed in a jailed npm lifecycle script/],
  ["deno", /deno subcommand is not allowed in a jailed npm lifecycle script/],
  ["net", /Requires (?:net|import) access|NotCapable[^\n]*\bnet\b/],
  ["write", /Requires write access|NotCapable[^\n]*\bwrite\b/],
];

/**
 * The errors the OS sandbox gives a confined program (`curl`, a compiler). Where the OS can't
 * confine the script's other programs (Windows) these mean something else (a locked file, a
 * real network failure), so they are not read as the jail's there.
 */
const OS_SIGNS: readonly [JailSign, RegExp][] = [
  ["net", /getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|fetch failed/i],
  [
    "write",
    /EACCES|EPERM|EROFS|Operation not permitted|permission denied|read-only file system/i,
  ],
];

/** Where the jail's clamp names the host a script asked for (every OS). */
const CLAMP_HOSTS: readonly RegExp[] = [
  /Requires net access to "([^"\s]+)"/g,
  /jail-scripts: (\S+) is not in this lifecycle script's network allow-list/g,
];

/** Where a confined program's resolver failure names the host (not on Windows: see OS_SIGNS). */
const OS_HOSTS: readonly RegExp[] = [/\b(?:ENOTFOUND|EAI_AGAIN)\s+(\S+)/g];

/**
 * A host as the runtime's `net` list takes it, and nothing else: the names come from the
 * script's own output, so only a plain lower-case DNS name with a dot is ever quoted back.
 */
const PLAIN_HOST =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,63}$/;

/** The host names `block` shows a script failing to reach, sorted, each once. */
function hostsIn(block: string, os: typeof Deno.build.os): string[] {
  const patterns = os === "windows" ? CLAMP_HOSTS : [...CLAMP_HOSTS, ...OS_HOSTS];
  const found = new Set<string>();
  for (const re of patterns) {
    for (const m of block.matchAll(re)) {
      const host = hostOf(m[1].replace(/[.,;:'")]+$/, ""));
      if (PLAIN_HOST.test(host) && host.length <= 253) found.add(host);
    }
  }
  return [...found].sort();
}

/** The signs `block` shows, in a stable order, each once. */
function signsIn(block: string, os: typeof Deno.build.os): JailSign[] {
  const table = os === "windows" ? CLAMP_SIGNS : [...CLAMP_SIGNS, ...OS_SIGNS];
  const found = new Set(table.filter(([, re]) => re.test(block)).map(([sign]) => sign));
  return (["npm", "deno", "net", "write"] as const).filter((sign) => found.has(sign));
}

/**
 * The dependencies' failed lifecycle scripts in an install's output (Deno's `error: script
 * '<script>' in '<name>@<version>' failed with exit code <n>` and the output it prints with it),
 * each with what the jail visibly stopped.
 *
 * @param output What `deno install` / `add` / `ci` printed.
 * @param os The OS the install ran on (default: this one); on Windows only Deno's own clamp
 *   messages count, since the OS doesn't confine the script's other programs there.
 * @returns The failures, in order.
 */
export function jailFailures(
  output: string,
  os: typeof Deno.build.os = Deno.build.os,
): JailFailure[] {
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
      signs: signsIn(block, os),
      ...(entry ? { entry } : {}),
      hosts: hostsIn(block, os),
    };
  });
}

/**
 * The built-in exception a failure points at, never wider than the project's own: a host list
 * the project already grants the package is kept rather than replaced by `"net": true`. Only a
 * package in denext's reviewed list gets one; anything else is never handed a paste-ready grant.
 */
function suggestedException(
  f: JailFailure,
  version: string | null | undefined,
  existing: JailPackageException | undefined,
): JailPackageException | null {
  if (!f.entry) return null;
  const exception = entryException(f.entry, version);
  if (exception.net === true && Array.isArray(existing?.net) && existing.net.length > 0) {
    return { ...exception, net: [...existing.net] };
  }
  return exception;
}

/** What a sign means, in the explanation's words. */
function stoppedText(sign: JailSign): string {
  return sign === "net"
    ? "the network"
    : sign === "write"
    ? "a write outside node_modules"
    : sign === "npm"
    ? "a real npm / npx"
    : "an installing deno subcommand";
}

/** The advice for a package outside denext's reviewed list: no grant to paste. */
function unreviewedAdvice(
  f: JailFailure,
  name: string,
  version: string | null | undefined,
): string[] {
  if (f.signs.includes("net")) {
    const hosts = f.hosts.length ? JSON.stringify(f.hosts).replaceAll(",", ", ") : '["<host>"]';
    const seen = f.hosts.length ? ` (the log shows it reaching ${f.hosts.join(", ")})` : "";
    return [
      `  warning: ${name} is not in denext's reviewed list, and its script tried to reach the ` +
      `network${seen}. An unreviewed install script that phones home is a common sign of malware.`,
      "  review the package and what its script fetches before granting anything; then grant " +
      `only the hosts it needs ("supplyChain.jailScripts.packages" → ${name} → "net": ` +
      `${hosts}, runtime ${JAIL_HOSTS_RELEASE} and later), never the whole network` +
      (version !== undefined && !jailHostListsSupported(version)
        ? `; ${
          version === null ? "this Deno" : `runtime ${version}`
        } takes no host list, so install it on ${JAIL_HOSTS_RELEASE} or later rather than ` +
          'grant "net": true'
        : ""),
    ];
  }
  if (f.signs.includes("write")) {
    return [
      `  after reviewing ${name}, list the directory it writes under ` +
      `"supplyChain.jailScripts.packages" → ${name} → "write" in deno.json`,
    ];
  }
  return [
    "  a real npm / npx or an installing deno subcommand is never allowed in the jail: " +
    "run that step yourself after the install",
  ];
}

/**
 * Explain an install log's failed lifecycle scripts as jail failures: which package, what the
 * jail stopped, and the exception to add (or why none helps). A paste-ready exception is given
 * only for a package in denext's reviewed list ({@linkcode JAIL_SCRIPT_EXCEPTIONS}) and never
 * widens a host list the project already grants; for any other package the log's name is only
 * quoted (it comes from the script's own output) and the advice is to review it first. Failures
 * with no sign of the jail and no built-in entry are left out.
 *
 * @param failures From {@linkcode jailFailures}.
 * @param version The runtime version (default: the toolchain pin's), for the exception's shape.
 * @param existing The project's own `supplyChain.jailScripts.packages`, kept from widening.
 * @returns One block of lines per failure the jail explains.
 */
export function explainJailFailures(
  failures: readonly JailFailure[],
  version?: string | null,
  existing: Readonly<Record<string, JailPackageException>> = {},
): string[] {
  const out: string[] = [];
  for (const f of failures) {
    if (f.signs.length === 0 && !f.entry) continue;
    const name = JSON.stringify(f.name);
    const stopped = f.signs.length
      ? f.signs.map(stoppedText).join(", ")
      : "nothing recognisable, but it is in denext's list";
    out.push(
      `${f.name}@${f.version}'s ${f.script} script failed in the lifecycle-script jail ` +
        `(stopped: ${stopped})`,
    );
    if (f.entry) out.push(`  ${f.entry.reason}`);
    const own = Object.hasOwn(existing, f.name) ? existing[f.name] : undefined;
    const exception = suggestedException(f, version, own);
    if (exception) {
      out.push(
        `  fix: deno.json "supplyChain": { "jailScripts": { "packages": { ${name}: ${
          JSON.stringify(exception)
        } } } }`,
      );
    } else {
      out.push(...unreviewedAdvice(f, name, version));
    }
    if (f.entry?.caveat) out.push(`  ${f.entry.caveat}`);
  }
  return out;
}

/** The first release of denext's Deno with per-package host lists and `upstreamByName`. */
export const UPSTREAM_BY_NAME_RELEASE = "3.0.0-rc.6";

/** The environment variables the jail's proxy chains through (only an `http://` proxy is). */
const PROXY_ENV = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
];

/**
 * The runtime's install-log warning that an upstream proxy refused the address the jail checked:
 * `jail-scripts: the upstream proxy refused a tunnel to <host:port> by its checked address (…)`
 * or `… (or the server) answered <status> to a request for <host:port> by its checked address`.
 */
const REFUSED_BY_ADDRESS =
  /jail-scripts: the upstream proxy (?:refused a tunnel to|\(or the server\) answered \d+ to a request for) (\S+) by its checked address/g;

/** The errors a script meets when the network is out of its reach (the clamp's and the OS's). */
const NET_SIGNS: readonly RegExp[] = [...CLAMP_SIGNS, ...OS_SIGNS]
  .filter(([sign]) => sign === "net")
  .map(([, re]) => re);

/** The allow-list refusal: the host was never one the script may reach. */
const NOT_LISTED = /jail-scripts: \S+ is not in this lifecycle script's network allow-list/;

/** A `host`, `host:port`, `[v6]` or `[v6]:port` reduced to its lower-cased host. */
function hostOf(target: string): string {
  const t = target.trim().toLowerCase();
  if (t.startsWith("[")) return t.slice(1, Math.max(1, t.indexOf("]")));
  const colons = t.split(":").length - 1;
  return colons === 1 ? t.slice(0, t.indexOf(":")) : t;
}

/** Whether the environment names an `http://` proxy, on a runtime that has `upstreamByName`. */
function proxyInEnv(env: UpstreamByNameInputs["env"], version: string | null): boolean {
  if (version === null || !isDenextReleaseVersion(version)) return false;
  if (compareDenoVersions(version, UPSTREAM_BY_NAME_RELEASE) < 0) return false;
  return PROXY_ENV.some((name) => /^http:\/\//i.test(env?.(name)?.trim() ?? ""));
}

/** A package exception's `net` host list (empty for `true` / `false` / none). */
function hostList(exception: unknown): string[] {
  const net = objectOf(exception)?.net;
  return Array.isArray(net) ? net.filter((h): h is string => typeof h === "string") : [];
}

/**
 * The listed hosts a failed script's block shows it failing to reach through the proxy: the one
 * the runtime's warning names, else (a proxy in the environment) the whole list when the block
 * shows a network failure that is not the allow-list's own refusal.
 */
function listedHostsReached(
  listed: readonly string[],
  refused: readonly string[],
  proxyEnv: boolean,
  block: string,
): string[] {
  const named = listed.map(hostOf).filter((h) => refused.includes(h));
  if (named.length) return named;
  const proxied = proxyEnv && NET_SIGNS.some((re) => re.test(block)) && !NOT_LISTED.test(block);
  return proxied ? listed.map(hostOf) : [];
}

/** What {@linkcode upstreamByNameAdvice} reads. */
export interface UpstreamByNameInputs {
  /** The install's output (`denext doctor --install-log`). */
  readonly output: string;
  /** The project's parsed deno.json (or null). */
  readonly denoJson: Record<string, unknown> | null;
  /** The environment (default: none). */
  readonly env?: (name: string) => string | undefined;
  /** The runtime version the project installs with (default: the toolchain pin's). */
  readonly version?: string | null;
}

/**
 * When to suggest `supplyChain.jailScripts.upstreamByName`: the project installs through an
 * upstream `http://` proxy (one named in `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` on a runtime
 * that has the setting, or the runtime's own warning that the proxy refused the checked address),
 * and a jailed script failed reaching a host its package's `net` host list allows. With the
 * setting the jail still checks the allow-list and refuses names that resolve to this machine or
 * its network, then asks the proxy for the host by name, so the proxy resolves it again itself.
 * Never suggests turning the jail off; says nothing once the setting is on.
 *
 * @param inputs The install log, deno.json, environment and runtime version.
 * @returns The advice lines (empty when it does not apply).
 */
export function upstreamByNameAdvice(inputs: UpstreamByNameInputs): string[] {
  const jail = objectOf(objectOf(inputs.denoJson?.supplyChain)?.jailScripts);
  if (jail?.upstreamByName === true) return [];
  const packages = objectOf(jail?.packages) ?? {};
  const text = stripAnsi(inputs.output);
  const refused = [...text.matchAll(REFUSED_BY_ADDRESS)].map((m) => hostOf(m[1]));
  const proxyEnv = proxyInEnv(
    inputs.env,
    inputs.version === undefined ? toolchainPin.version : inputs.version,
  );
  if (!proxyEnv && refused.length === 0) return [];
  const matches = [...text.matchAll(FAILED_SCRIPT)];
  const hits = matches.flatMap((m, i) => {
    const listed = hostList(packages[m[2]]);
    const block = text.slice(m.index, matches[i + 1]?.index ?? text.length);
    const hosts = listedHostsReached(listed, refused, proxyEnv, block);
    return hosts.length ? [`${m[2]} (${hosts.join(", ")})`] : [];
  });
  if (hits.length === 0) return [];
  return [
    `${hits.join(", ")}: a jailed script failed to reach a listed host through this network's ` +
    "proxy, which may accept only host names, not the address the jail checked",
    '  fix: deno.json "supplyChain": { "jailScripts": { "upstreamByName": true } } asks the ' +
    "proxy for the host by name. Trade-off: the jail still checks the allow-list and refuses a " +
    "name that resolves to this machine or its network, but the proxy then resolves the name " +
    "again itself, so a name whose DNS answers differently there can reach what the proxy " +
    "reaches. Keep the jail on.",
  ];
}
