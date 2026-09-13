// The migration-bed harness: clone a SHA-pinned real-world app, install its dependencies,
// run `denext migrate` against THIS checkout (`--denext-local-path`), build it, serve it
// through the real CLI, and render-assert a handful of routes. One test file per bed
// (`<bed>.test.ts`) describes the app as data ({@linkcode Bed}) and calls {@linkcode runBed}.
//
// Skip vs. fail: a clone or dependency install that fails for NETWORK reasons skips the bed
// (warn + return, the `tests/e2e/drizzle.e2e.test.ts` idiom — the nightly runner may be
// offline or npm may be down); everything after the install is a real failure, because that
// is where a denext regression shows up. `denext doctor` runs last as an informational
// report (printed, not asserted) until its route expectations are tunable per bed.
//
// Run: `deno task test:migration-bed` (NETWORK-REQUIRED; the `migration-beds` job in
// .github/workflows/e2e.yml runs it nightly). Never part of `deno task check`/`test`.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { startCliServer } from "../e2e/harness.ts";

/** One route to render-assert after the migrated app is built and served. */
interface BedRoute {
  /** Path to fetch (`/`, `/posts/2`, …). */
  path: string;
  /** Expected HTTP status (default 200). */
  status?: number;
  /** A substring the response body must contain. */
  contains: string;
}

/** A real-world app to migrate, as data. */
export interface Bed {
  /** Short name (used in messages). */
  name: string;
  /** The git remote to fetch from. */
  repo: string;
  /** The FULL commit SHA to pin (a depth-1 fetch of the SHA, so the pin is exact). */
  sha: string;
  /** The app directory inside the clone, for a monorepo. */
  subdir?: string;
  /** Dependency-install commands, run in order in the app dir (`[["pnpm", "install", …]]`). */
  install: string[][];
  /** App-specific setup after the install and before migrate (an env file, a DB seed). */
  prepare?: (appDir: string) => Promise<void>;
  /** Extra `denext migrate` flags (`["--from", "remix"]`). */
  migrate?: string[];
  /** The `kind` migrate must report (`"next"`, `"spa"`, `"remix"`, …). */
  kind: string;
  /** `flagged` dependencies the bed tolerates (native deps the app does not exercise). */
  allowFlagged?: string[];
  /** Routes to render-assert. */
  routes: BedRoute[];
}

const REPO = fromFileUrl(new URL("../../", import.meta.url));
const CLI = join(REPO, "cli.ts");

const CLONE_TIMEOUT_MS = 180_000;
const INSTALL_TIMEOUT_MS = 600_000;
const MIGRATE_TIMEOUT_MS = 180_000;
const BUILD_TIMEOUT_MS = 600_000;
const READY_TIMEOUT_MS = 120_000;
const DOCTOR_TIMEOUT_MS = 300_000;

/** Output that means "the network, not denext" — the bed skips instead of failing. */
const NETWORK_FAILURE =
  /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|Could not resolve host|unable to access|registry\.npmjs\.org|network|fetch failed|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH/i;

/** Run a command in `cwd`, bounded by `timeoutMs`. Never throws — reports instead. */
async function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: Record<string, string> = {},
): Promise<{ ok: boolean; out: string }> {
  try {
    const { success, stdout, stderr } = await new Deno.Command(cmd, {
      args,
      cwd,
      env,
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(timeoutMs),
    }).output();
    return {
      ok: success,
      out: new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr),
    };
  } catch (e) {
    return {
      ok: false,
      out: `\`${cmd} ${args.join(" ")}\` did not finish within ${timeoutMs}ms: ${e}`,
    };
  }
}

/** The CLI, as the migrated app's generated tasks run it (see `spaTasks`/`nextTasks` in migrate). */
function denext(args: string[], cwd: string, timeoutMs: number) {
  return run(
    Deno.execPath(),
    ["run", "-A", "--node-modules-dir=none", CLI, ...args],
    cwd,
    timeoutMs,
    { DENEXT_MIN_DEP_AGE: "0" },
  );
}

/** A depth-1 fetch of exactly `sha` into a fresh temp dir (a branch name would drift). */
async function cloneAt(bed: Bed): Promise<{ dir: string; skip?: string }> {
  const dir = await Deno.makeTempDir({ prefix: `denext_bed_${bed.name.replace(/[^\w-]/g, "_")}_` });
  const git = (args: string[]) => run("git", args, dir, CLONE_TIMEOUT_MS);
  const steps = [
    ["init", "-q"],
    ["remote", "add", "origin", bed.repo],
    ["fetch", "-q", "--depth", "1", "origin", bed.sha],
    ["checkout", "-q", "FETCH_HEAD"],
  ];
  for (const args of steps) {
    const r = await git(args);
    if (r.ok) continue;
    if (args[0] === "fetch" && NETWORK_FAILURE.test(r.out)) {
      return { dir, skip: `git fetch failed (offline / GitHub unreachable?):\n${r.out}` };
    }
    throw new Error(`git ${args.join(" ")} failed for ${bed.name}:\n${r.out}`);
  }
  return { dir };
}

/** The JSON document `denext migrate --json` printed (download/progress lines may precede it). */
function parseMigrateJson(out: string): Record<string, unknown> {
  const start = out.indexOf("{");
  assert(start >= 0, `migrate --json printed no JSON:\n${out}`);
  return JSON.parse(out.slice(start, out.lastIndexOf("}") + 1));
}

/** Clone → install → prepare → migrate → build → serve → render-assert → doctor (informational). */
export async function runBed(t: Deno.TestContext, bed: Bed): Promise<void> {
  const { dir, skip } = await cloneAt(bed);
  try {
    if (skip) {
      console.warn(`migration-bed ${bed.name}: skipping — ${skip}`);
      return;
    }
    const app = bed.subdir ? join(dir, bed.subdir) : dir;

    for (const [cmd, ...args] of bed.install) {
      const r = await run(cmd, args, app, INSTALL_TIMEOUT_MS);
      if (r.ok) continue;
      if (NETWORK_FAILURE.test(r.out)) {
        console.warn(
          `migration-bed ${bed.name}: skipping — \`${cmd} ${
            args.join(" ")
          }\` failed (npm unreachable / offline?):\n${r.out.slice(-2000)}`,
        );
        return;
      }
      throw new Error(`${bed.name}: \`${cmd} ${args.join(" ")}\` failed:\n${r.out}`);
    }
    await bed.prepare?.(app);

    await t.step("denext migrate", async () => {
      const r = await denext(
        ["migrate", ".", "--denext-local-path", REPO, "--json", ...(bed.migrate ?? [])],
        app,
        MIGRATE_TIMEOUT_MS,
      );
      assert(r.ok, `migrate failed:\n${r.out}`);
      const report = parseMigrateJson(r.out);
      assertEquals(
        report.kind,
        bed.kind,
        `migrate detected the wrong kind: ${JSON.stringify(report)}`,
      );
      const flagged = ((report.flagged as string[]) ?? []).filter(
        (f) => !(bed.allowFlagged ?? []).some((a) => f === a || f.startsWith(a + "@")),
      );
      assertEquals(flagged, [], "migrate flagged dependencies the bed does not tolerate");
      assertEquals(report.denoJsonExists, false, "the clone must not already carry a deno.json");
    });

    await t.step("denext build", async () => {
      const r = await denext(["build", "."], app, BUILD_TIMEOUT_MS);
      assert(r.ok, `build failed:\n${r.out}`);
    });

    const server = await startCliServer(app, READY_TIMEOUT_MS);
    try {
      await t.step("routes render", async () => {
        const failures: string[] = [];
        for (const route of bed.routes) {
          const res = await fetch(server.origin + route.path);
          const body = await res.text();
          const want = route.status ?? 200;
          if (res.status !== want) {
            failures.push(`${route.path}: status ${res.status}, expected ${want}`);
          } else if (!body.includes(route.contains)) {
            failures.push(
              `${route.path}: body lacks ${JSON.stringify(route.contains)} (${body.length} bytes)`,
            );
          }
        }
        assertEquals(failures, [], `${bed.name}: route assertions failed`);
      });
    } finally {
      await server.close();
    }

    await t.step("denext doctor (informational)", async () => {
      const r = await denext(["doctor", ".", "--report", "--json"], app, DOCTOR_TIMEOUT_MS);
      const start = r.out.indexOf("{");
      const summary = start >= 0 ? summarizeDoctor(r.out.slice(start)) : r.out.slice(-1500);
      console.log(
        `migration-bed ${bed.name}: denext doctor → ${
          r.ok ? "ok" : "reported failures"
        }\n${summary}`,
      );
    });
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/**
 * A `doctor --report --json` document, condensed: each check as `name: ok|FAIL (detail…)`,
 * then the route-probe totals and the routes that did not pass. In-process route probing
 * cannot load a compat app's CSS imports (`probeApp` imports route modules directly), so a
 * failing "route conformance" check is expected noise for these beds — the served-route
 * assertions above are the real gate.
 */
function summarizeDoctor(json: string): string {
  try {
    const d = JSON.parse(json.slice(0, json.lastIndexOf("}") + 1)) as {
      checks?: { name: string; ok: boolean; detail: string }[];
      routes?: {
        total?: number;
        passed?: number;
        failed?: number;
        routes?: { path: string; status: number; ok: boolean }[];
      } | null;
    };
    const checks = (d.checks ?? []).map((c) =>
      `  ${c.name}: ${c.ok ? "ok" : "FAIL"}${
        c.ok ? "" : ` (${c.detail.split("\n")[0].slice(0, 160)})`
      }`
    );
    const routes = d.routes
      ? [
        `  routes: total ${d.routes.total} · passed ${d.routes.passed} · failed ${d.routes.failed}`,
        ...(d.routes.routes ?? []).filter((r) => !r.ok).slice(0, 20).map((r) =>
          `    ${r.path} → ${r.status}`
        ),
      ]
      : ["  routes: not probed"];
    return [...checks, ...routes].join("\n");
  } catch {
    return json.slice(0, 1500);
  }
}
