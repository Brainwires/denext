// The process-wide facts of a `deno compile`d app (`denext build --compile`): where the embedded
// project lives and where the app may write. The binary's entry (`denext/standalone`) records them
// before anything loads the project; the server, the job runner and the database verbs read them.
// A process that is not such a binary has none, and every reader falls back to the project's own
// paths. Kept in a global slot so a plugin package (`@denext/backend`) reads the same record.

/** What a compiled app records about itself. */
export interface StandaloneState {
  /** The embedded project's root (inside the binary's read-only file system). */
  readonly projectDir: string;
  /**
   * Where the app keeps what it writes at run time (the page cache, the job history), absolute:
   * `DENEXT_STATE_DIR`, else `.denext` under the working directory — the same `.denext` a
   * `denext start` deployment writes.
   */
  readonly stateDir: string;
  /**
   * The directory relative data paths resolve against (a SQLite `DB_PATH`, a storage driver's
   * `dir`): the working directory, as for an app's own `new DatabaseSync("app.db")`.
   */
  readonly dataDir: string;
}

const SLOT = Symbol.for("denext.standalone");

/**
 * Record the compiled app's facts (the binary's entry does, once, at startup).
 *
 * @param state The facts.
 */
export function setStandaloneState(state: StandaloneState): void {
  (globalThis as Record<symbol, unknown>)[SLOT] = Object.freeze({ ...state });
}

/**
 * The compiled app's facts, or `undefined` outside a `denext build --compile` binary.
 *
 * @returns The recorded state.
 */
export function standaloneState(): StandaloneState | undefined {
  return (globalThis as Record<symbol, unknown>)[SLOT] as StandaloneState | undefined;
}

/**
 * Where the run-time state of the build in `outDir` goes: the compiled app's state directory
 * (its embedded `.denext` is read-only), else `outDir` itself.
 *
 * @param outDir The build output directory.
 * @returns The directory to write the page cache and the job history in.
 */
export function runtimeStateDir(outDir: string): string {
  return standaloneState()?.stateDir ?? outDir;
}
