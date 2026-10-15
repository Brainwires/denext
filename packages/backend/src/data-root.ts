// Where the backend's relative data paths (the fs driver's `dir`, the storage metadata file)
// resolve: the project, or in a `denext build --compile` binary — whose project is embedded and
// read-only — the data directory the binary records (its working directory). Read from denext's
// global slot (`Symbol.for("denext.standalone")`), so this package needs no newer denext to run.

/**
 * The directory a relative data path resolves against.
 *
 * @param projectRoot The project root (the plugin context's).
 * @returns `projectRoot`, or a compiled app's data directory.
 */
export function dataRoot(projectRoot: string): string {
  const dir = standalone()?.dataDir;
  return typeof dir === "string" ? dir : projectRoot;
}

/**
 * Where a compiled app keeps its run-time state (`DENEXT_STATE_DIR`, else `./.denext`), absolute;
 * `undefined` outside a `denext build --compile` binary.
 */
export function compiledStateDir(): string | undefined {
  const dir = standalone()?.stateDir;
  return typeof dir === "string" ? dir : undefined;
}

/** denext's record of a compiled app, when this process is one. */
function standalone(): { dataDir?: unknown; stateDir?: unknown } | undefined {
  return (globalThis as Record<symbol, unknown>)[Symbol.for("denext.standalone")] as
    | { dataDir?: unknown; stateDir?: unknown }
    | undefined;
}
