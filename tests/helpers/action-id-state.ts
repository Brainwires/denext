// The process-wide Server Action id state a test changes, restored after every test of the file.
//
// The secret ids are minted under lives on `globalThis` (src/server/action-ids.ts keeps it in
// `processShared("actionIdSecret")`, so every loaded copy of the module agrees), and so does the
// exposure policy (src/runtime/server-action.ts, `processShared("serverActionExposure")`). A test
// that installs a build secret (`setBuildActionIdSecret`, or an in-process `denext start` reading
// a build's manifest) or turns on the legacy ids and then fails half-way would otherwise leave
// every later test of its file minting ids under that secret. `DENEXT_ACTION_ID_SECRET` is the
// process's environment, shared by every file of a parallel run: a test that sets it restores it
// itself (and its file is in tests/serial-tests.ts).

/** The `processShared` slots that hold the action-id state. */
const SLOTS = ["actionIdSecret", "serverActionExposure"].map((name) =>
  Symbol.for(`denext.shared.${name}`)
);

/** What {@linkcode snapshotActionIdState} saw: a copy of each shared slot. */
type ActionIdState = ReadonlyArray<Record<string, unknown> | undefined>;

/** The action-id state as it is now. */
function snapshotActionIdState(): ActionIdState {
  const shared = globalThis as unknown as Record<symbol, Record<string, unknown> | undefined>;
  return SLOTS.map((key) => shared[key] && { ...shared[key] });
}

/**
 * Put the action-id state back as `saved` had it (in place: the modules hold the slot objects).
 *
 * @param saved What {@linkcode snapshotActionIdState} returned.
 */
function restoreActionIdState(saved: ActionIdState): void {
  const shared = globalThis as unknown as Record<symbol, Record<string, unknown> | undefined>;
  SLOTS.forEach((key, i) => {
    const before = saved[i];
    const now = shared[key];
    if (!before || !now) return; // the module creates its slot as it loads, before any test
    for (const field of Object.keys(now)) if (!(field in before)) delete now[field];
    Object.assign(now, before);
  });
}

/**
 * Snapshot the action-id state before every test of the calling file and restore it after each
 * one, however the test ends. Call once at module level.
 */
export function restoreActionIdStateAfterEachTest(): void {
  let saved: ActionIdState | undefined;
  Deno.test.beforeEach(() => {
    saved = snapshotActionIdState();
  });
  Deno.test.afterEach(() => {
    if (saved) restoreActionIdState(saved);
    saved = undefined;
  });
}
