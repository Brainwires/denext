// The `services/` directory convention: discover `services/**`, put every service (and nested
// supervisor) a file default-exports under one root supervisor named `services`, start it at
// server boot, and stop it on the drain. Mirrors `./job-loader.ts` — runtime discovery, no build
// manifest — and keeps `./supervise.ts` (which service files import) free of the filesystem walk.
//
// Visibility: the root registers a `services` readiness check on `/_denext/health` (down once the
// tree has given up), reports a failure to `instrumentation.ts`'s `onServiceError`, and keeps a
// status snapshot in `<outDir>/services.json` for `denext ui`'s Services page — a file, because
// the UI never runs project code in its own process.

import { join } from "@std/path";
import { registerHealthCheck } from "./health.ts";
import type { OnServiceError } from "./instrumentation.ts";
import { inRootContext } from "./root-context.ts";
import { importModules } from "./module-walk.ts";
import {
  isService,
  isSupervisor,
  nameSupervisor,
  type Service,
  setSupervisionReporter,
  stopAllSupervisors,
  supervise,
  supervisionStatus,
  type Supervisor,
  type SupervisorStatus,
} from "./supervise.ts";

/** The status snapshot's file name, under the build directory (`.denext/services.json`). */
export const SERVICES_SNAPSHOT = "services.json";

/** The snapshot file's shape (what `denext ui` reads). */
export interface ServicesSnapshot {
  /** The serving process. */
  readonly pid: number;
  /** When this snapshot was written (epoch ms). */
  readonly updatedAt: number;
  /** Every top-level supervisor's status. */
  readonly supervisors: readonly SupervisorStatus[];
}

/** How long status changes are coalesced before the snapshot is rewritten (ms). */
const SNAPSHOT_DEBOUNCE_MS = 100;

/** One discovered `services/` module. */
interface Discovered {
  readonly name: string;
  readonly child: Service | Supervisor;
}

/** A module's service: its default export, or a named `service` / `supervisor` export. */
function exported(mod: Record<string, unknown>): unknown {
  return mod.default ?? mod.service ?? mod.supervisor;
}

/**
 * Discover `services/**` under `dir`, importing each module. A missing directory is fine
 * (`[]`); a module that fails to load or exports neither `defineService(...)` nor
 * `supervise(...)` is logged and skipped — a bad service file never takes the server down.
 *
 * @param dir The `services/` directory.
 * @returns The services, sorted by path.
 */
export async function discoverServices(dir: string): Promise<Discovered[]> {
  const found: Discovered[] = [];
  for await (const { rel, name, mod } of importModules(dir, "service")) {
    const child = exported(mod);
    if (isService(child)) {
      found.push({ name, child: { ...child, name: child.name ?? name } });
    } else if (isSupervisor(child)) {
      nameSupervisor(child, name);
      found.push({ name, child });
    } else {
      console.error(
        `denext: services/${rel} does not default-export defineService(...) or supervise(...) — skipped`,
      );
    }
  }
  return found.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * Keep `<outDir>/services.json` in step with the supervision tree: rewritten (atomically, through
 * a temporary file) at most every {@link SNAPSHOT_DEBOUNCE_MS} after a change. A write that fails
 * (a read-only filesystem, no `--allow-write`) turns the snapshot off — it is never worth a
 * failed service.
 *
 * @param root The supervisor whose changes trigger a write.
 * @param outDir The build directory.
 * @returns Writes the final snapshot and stops watching.
 */
function startSnapshot(root: Supervisor, outDir: string): () => Promise<void> {
  const path = join(outDir, SERVICES_SNAPSHOT);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let broken = false;
  const write = async (): Promise<void> => {
    if (broken) return;
    const snapshot: ServicesSnapshot = {
      pid: Deno.pid,
      updatedAt: Date.now(),
      supervisors: supervisionStatus(),
    };
    try {
      await Deno.mkdir(outDir, { recursive: true });
      const tmp = `${path}.${Deno.pid}.tmp`;
      await Deno.writeTextFile(tmp, JSON.stringify(snapshot, null, 2) + "\n");
      await Deno.rename(tmp, path);
    } catch {
      broken = true;
    }
  };
  const off = root.onStatus(() => {
    if (timer !== undefined) return;
    timer = inRootContext(() =>
      setTimeout(() => {
        timer = undefined;
        void write();
      }, SNAPSHOT_DEBOUNCE_MS)
    );
  });
  return async () => {
    off();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    await write();
  };
}

/** What {@linkcode bootServices} needs from the server's boot. */
export interface ServicesBootOptions {
  /** The build directory (`.denext`), where the status snapshot is kept. */
  readonly outDir: string;
  /** The project's `instrumentation.ts` `onServiceError`, when it has one. */
  readonly onServiceError?: OnServiceError;
}

/** What the running `services/` tree needs at shutdown. */
let running: { root: Supervisor; stopSnapshot: () => Promise<void>; unhealth: () => void } | null =
  null;

/**
 * Boot the `services/` tree at server startup: discover `<projectDir>/services/**`, put them under
 * one `one_for_one` root supervisor named `services`, and start it. A no-op — and no log — when
 * the project has no `services/` directory. Idempotent: a second call while one is running
 * returns it.
 *
 * @param projectDir The project root.
 * @param options The build directory and the failure hook.
 * @returns The root supervisor, or `null` when there is nothing to supervise.
 */
export async function bootServices(
  projectDir: string,
  options: ServicesBootOptions,
): Promise<Supervisor | null> {
  if (running) return running.root;
  // Before the early return: a supervisor the app starts itself (from `register()`, say) reports
  // its failure to the same hook as the `services/` tree.
  const hook = options.onServiceError;
  setSupervisionReporter(hook ? (error) => hook(error, { path: error.path }) : null);
  const found = await discoverServices(join(projectDir, "services"));
  if (found.length === 0) return null;
  let root: Supervisor;
  try {
    root = supervise({ name: "services", children: found.map((f) => f.child) });
  } catch (err) {
    // Two files naming their service alike, or a supervisor nested twice: refuse the tree, never
    // the server.
    console.error("denext: the services/ tree is invalid — no service started:", err);
    return null;
  }
  const unhealth = registerHealthCheck("services", () => root.status().state !== "failed");
  const stopSnapshot = startSnapshot(root, options.outDir);
  running = { root, stopSnapshot, unhealth };
  await inRootContext(() => root.start());
  console.log(`  ${found.length} service(s) supervised`);
  return root;
}

/**
 * Stop every supervisor — the `services/` tree and any an app started itself — in reverse start
 * order, then write the final status snapshot. The server drain calls it once in-flight requests
 * have finished, before plugin teardowns (a service may still use what a plugin holds open).
 */
export async function stopServices(): Promise<void> {
  await stopAllSupervisors();
  setSupervisionReporter(null);
  const current = running;
  running = null;
  if (!current) return;
  current.unhealth();
  await current.stopSnapshot();
}
