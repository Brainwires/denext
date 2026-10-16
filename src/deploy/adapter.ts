// The deploy adapter seam: what an adapter is, and the context denext hands it. Types only (plus
// the identity helper), so a third-party adapter depends on the contract and nothing else.
//
// An adapter turns the deploy manifest into a target's own files (`prepare`, run after every
// `denext build` when the config names the adapter, and by `denext deploy prepare`) and, when the
// target has a CLI, pushes them (`deploy`, run only by an explicit `denext deploy`). Credentials
// only ever come from the environment ({@linkcode DeployContext.env}); nothing is written that
// holds one.

import type { DeployManifest } from "./manifest.ts";

/** Where {@linkcode DeployContext.writeFile} writes. */
export interface DeployWriteOptions {
  /**
   * `"output"` (default): under {@linkcode DeployContext.outDir}, the adapter's own directory,
   * replaced freely. `"project"`: under the project root, for files a target's tooling expects
   * there (`Dockerfile`, `fly.toml`) — an existing file is replaced only when it carries
   * {@linkcode marker} (denext wrote it), else it is left alone with a warning (`--force`
   * replaces it).
   */
  readonly in?: "output" | "project";
  /** The generated-file marker a `"project"` file carries (required there). */
  readonly marker?: string;
}

/** Options for {@linkcode DeployContext.run}. */
export interface DeployRunOptions {
  /** The working directory (default: the project root). */
  readonly cwd?: string;
}

/** What an adapter's `prepare` and `deploy` receive. */
export interface DeployContext {
  /** The deploy manifest of the build. */
  readonly manifest: DeployManifest;
  /** The project root (absolute). */
  readonly projectDir: string;
  /** The adapter's output directory (absolute): `.denext/deploy/<adapter name>/`. */
  readonly outDir: string;
  /** `--dry-run`: say what would be written or run, and write / run nothing. */
  readonly dryRun: boolean;
  /**
   * Write a generated file (UTF-8). Resolves to whether it was written: `false` when dry-running
   * or when a hand-edited project file was left alone.
   *
   * @param path A relative, `/`-separated path (no `..`).
   * @param contents The file's contents.
   * @param options Where it goes (the adapter's directory by default).
   */
  writeFile(path: string, contents: string, options?: DeployWriteOptions): Promise<boolean>;
  /** Print a progress line. */
  log(message: string): void;
  /** Print a warning (something the target cannot do, a file left alone). */
  warn(message: string): void;
  /** Read an environment variable (credentials come from here, never from a file). */
  env(name: string): string | undefined;
  /** The first of `names` on `PATH`, as an absolute path, or `null`. */
  which(...names: string[]): Promise<string | null>;
  /**
   * Run a command with the terminal attached and the process's environment, resolving to its
   * exit code (a dry run prints it and resolves to `0`).
   */
  run(command: readonly string[], options?: DeployRunOptions): Promise<number>;
  /** Run `denext export` on the project and resolve to the export directory (absolute). */
  exportStatic(): Promise<string>;
}

/**
 * A deploy adapter: {@linkcode prepare} writes a target's files from the manifest, and the
 * optional {@linkcode deploy} pushes them with the target's own CLI. Declare one in
 * `denext.config.ts` as `deploy: { adapter: fly({ app: "my-app" }) }`, or contribute one from a
 * plugin with `addDeployAdapter`.
 */
export interface DeployAdapter {
  /** The adapter's name (its output directory under `.denext/deploy/`). */
  readonly name: string;
  /**
   * Write the target's files. Throw an `Error` whose message starts with `denext:` to refuse the
   * app (the static preset does, for routes that need a server).
   */
  prepare(context: DeployContext): void | Promise<void>;
  /** Push the prepared output (`denext deploy`). Absent: the target has no CLI denext drives. */
  deploy?(context: DeployContext): void | Promise<void>;
}

/** The `deploy` key of `denext.config.ts`. */
export interface DeployConfig {
  /**
   * The adapter `denext build` runs after every build (its `prepare`), and `denext deploy` uses:
   * a preset from `denext/deploy` (`docker()`, `fly()`, `denoDeploy()`, `genericHost()`,
   * `staticHost()`) or your own {@linkcode DeployAdapter}.
   */
  adapter?: DeployAdapter;
}

/**
 * Declare a deploy adapter (an identity function that type-checks the object).
 *
 * @param adapter The adapter.
 * @returns The same adapter.
 */
export function defineDeployAdapter(adapter: DeployAdapter): DeployAdapter {
  return adapter;
}
