// The migration-bed harness: clone a SHA-pinned real-world app, install its dependencies,
// run `denext migrate` against THIS checkout (`--denext-local-path`), build it, serve it
// through the real CLI, and render-assert a handful of routes. One test file per bed
// (`<bed>.test.ts`) describes the app as data ({@linkcode Bed}) and calls {@linkcode runBed}.
//
// Skip vs. fail: a clone, dependency install or post-migrate setup command (`afterMigrate`:
// Prisma engines, a seed) that fails for NETWORK reasons skips the bed (warn + return, the
// `tests/e2e/drizzle.e2e.test.ts` idiom — the CI runner may be offline or npm may be
// down); `denext migrate`, the build, serving and the route assertions are real failures,
// because that is where a denext regression shows up. `denext doctor` runs last as an informational
// report (printed, not asserted) until its route expectations are tunable per bed.
//
// Run: `deno task test:migration-bed` (NETWORK-REQUIRED; the `migration-beds` job in
// .github/workflows/e2e.yml runs it when dispatched before a release). Never part of `deno task check`/`test`.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import type { Page } from "@astral/astral";
import { killTree, launchBrowser, pollFor, startCliServer } from "../e2e/harness.ts";
import { BED_ENV, holdBedDependencies } from "./_dep-age.ts";

/** One route to render-assert after the migrated app is built and served. */
interface BedRoute {
  /** Path to fetch (`/`, `/posts/2`, …). */
  path: string;
  /** Expected HTTP status (default 200). */
  status?: number;
  /** A substring the response body must contain (skip with `""`). */
  contains: string;
  /** For a redirect: a substring the `Location` header must contain (redirects are not followed). */
  location?: string;
  /** Request headers (a browser's `Accept`, for an app that answers by it). */
  headers?: Record<string, string>;
}

/**
 * A page to open in headless Chromium after the route assertions: it must hydrate, and with
 * `navigate`, a click must navigate on the client (the document stays the same one).
 */
interface BedBrowserCheck {
  /** Path to open. */
  path: string;
  /** A JS expression, polled in the page until truthy: the app hydrated. */
  hydrated: string;
  /** A link to click (a CSS selector) and an expression that is truthy once it navigated. */
  navigate?: BedAction;
  /**
   * An interaction on the hydrated page: a control to click (a CSS selector) and an expression
   * that is truthy once the page reacted (an island's state changed), on the same document.
   */
  interact?: BedAction;
}

/**
 * A click and the expression that is truthy once the page reacted: `click` is a CSS selector
 * (a real mouse click on it); `press` is a JS expression that clicks a control a selector cannot
 * name (a button known only by its text), run in the page instead.
 */
type BedAction =
  & { until: string }
  & ({ click: string; press?: never } | {
    press: string;
    click?: never;
  });

/**
 * A setup command with its own deadline. `expect` marks success by output: a script that does
 * its work and then never exits (a DB seed holding a Prisma engine handle open) counts as done
 * once its output contains `expect`, even though the deadline had to kill it.
 */
interface TimedCommand {
  cmd: string[];
  timeoutMs?: number;
  expect?: string;
}

/**
 * A golden check on a file `denext migrate` wrote or rewrote: substrings it must hold, and ones
 * it must not (what the migration replaced).
 */
interface BedFile {
  /** The file, relative to the app dir. */
  path: string;
  /** Substrings the migrated file must contain. */
  contains?: string[];
  /** Substrings it must not contain. */
  absent?: string[];
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
  /**
   * An edit after migrate and before build — the hand fix `migrate --check` asked for (a source
   * line denext cannot run as written), applied the way the report says to.
   */
  afterMigrateEdit?: (appDir: string) => Promise<void>;
  /** Extra `denext migrate` flags (`["--from", "remix"]`). */
  migrate?: string[];
  /**
   * Commands to run after migrate and before build, in the app dir — the setup a migrated
   * app's README asks for (a Prisma task migrate generated, an icon build, a DB seed). The
   * token `$deno` is this test's Deno binary, `$denext` the CLI under test (its `run` / `task`
   * verbs run on denext's Deno toolchain). Same network-skip semantics as `install`; an
   * entry may be a {@linkcode TimedCommand} for its own deadline / success marker.
   */
  afterMigrate?: Array<string[] | TimedCommand>;
  /** The `kind` migrate must report (`"next"`, `"spa"`, `"remix"`, …). */
  kind: string;
  /**
   * The permissions the generated `start` task must carry: `"least-privilege"` (the set
   * `denext create` writes, no `-A`) or `"all"` (`-A`). Unchecked when absent.
   */
  start?: "least-privilege" | "all";
  /** Golden checks on what migrate wrote, asserted right after it ran. */
  files?: BedFile[];
  /** `flagged` dependencies the bed tolerates (native deps the app does not exercise). */
  allowFlagged?: string[];
  /** Routes to render-assert. */
  routes: BedRoute[];
  /** A page to hydrate (and navigate from) in headless Chromium. */
  browser?: BedBrowserCheck;
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
  // Specific transport errors only — a bare /network/ once matched a real setup failure whose
  // output merely mentioned the word, turning a regression into a silent skip.
  /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|Could not resolve host|unable to access|registry\.npmjs\.org|TypeError: fetch failed|error sending request for url|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH/i;

/**
 * Run a command in `cwd`, bounded by `timeoutMs`. Never throws — reports instead. The
 * deadline SIGKILLs the whole process tree (`killTree`): `AbortSignal.timeout` only sends
 * SIGTERM to the direct child, which a seed script holding a database engine open ignored
 * for ten minutes. Output read before the kill is kept, so a caller can still recognise a
 * "done" line from a process that finished its work and then never exited.
 */
async function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: Record<string, string> = {},
): Promise<{ ok: boolean; out: string }> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(cmd, { args, cwd, env, stdout: "piped", stderr: "piped" }).spawn();
  } catch (e) {
    return { ok: false, out: `could not spawn \`${cmd} ${args.join(" ")}\`: ${e}` };
  }
  const chunks: Uint8Array[] = [];
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) chunks.push(chunk);
  };
  const drained = Promise.all([collect(child.stdout), collect(child.stderr)]);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child.pid).catch(() => {});
  }, timeoutMs);
  const status = await child.status;
  clearTimeout(timer);
  // An orphaned grandchild can hold the pipes open after the kill — do not wait on it forever.
  let grace: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([drained, new Promise((r) => grace = setTimeout(r, 3000))]);
  clearTimeout(grace);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  const out = new TextDecoder().decode(bytes);
  return {
    ok: status.success && !timedOut,
    out: timedOut ? `${out}\n[\`${cmd} ${args.join(" ")}\` killed after ${timeoutMs}ms]` : out,
  };
}

/** The CLI, as the migrated app's generated tasks run it (see `spaTasks`/`nextTasks` in migrate). */
function denext(args: string[], cwd: string, timeoutMs: number) {
  return run(
    Deno.execPath(),
    ["run", "-A", "--node-modules-dir=none", CLI, ...args],
    cwd,
    timeoutMs,
    BED_ENV,
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

/**
 * Run `commands` in order in the app dir. Returns false (after warning) when one failed for
 * network reasons — the caller skips the bed; throws on any other failure.
 */
async function runCommands(
  bed: Bed,
  commands: Array<string[] | TimedCommand>,
  app: string,
): Promise<boolean> {
  for (const entry of commands) {
    const timed: TimedCommand = Array.isArray(entry) ? { cmd: entry } : entry;
    const [cmd, ...args] = timed.cmd;
    const [bin, argv] = commandLine(cmd, args);
    const r = await run(bin, argv, app, timed.timeoutMs ?? INSTALL_TIMEOUT_MS, BED_ENV);
    if (r.ok || (timed.expect !== undefined && r.out.includes(timed.expect))) continue;
    if (NETWORK_FAILURE.test(r.out)) {
      console.warn(
        `migration-bed ${bed.name}: skipping — \`${cmd} ${args.join(" ")}\` failed ` +
          `(npm unreachable / offline?):\n${r.out.slice(-2000)}`,
      );
      return false;
    }
    throw new Error(`${bed.name}: \`${cmd} ${args.join(" ")}\` failed:\n${r.out}`);
  }
  return true;
}

/**
 * The binary and arguments a bed command runs. `$denext` is the CLI under test, so its verbs
 * (`denext run`, `denext task`) run on denext's Deno toolchain, as the migrated app's README
 * steps do; `$deno` is that toolchain itself.
 */
function commandLine(cmd: string, args: string[]): [string, string[]] {
  const bin = cmd === "$deno" || cmd === "$denext" ? Deno.execPath() : cmd;
  return [bin, cmd === "$denext" ? ["run", "-A", "--node-modules-dir=none", CLI, ...args] : args];
}

/** The migrated app's `start` task carries the permissions `want` names. */
function assertStartPermissions(app: string, want: "least-privilege" | "all"): void {
  const start = String(JSON.parse(Deno.readTextFileSync(join(app, "deno.json"))).tasks?.start);
  const prefix = want === "all"
    ? "deno run -A --node-modules-dir=none "
    : "deno run --node-modules-dir=none --allow-net --allow-read --allow-env --allow-write=.denext ";
  assert(start.startsWith(prefix), `start task is not ${want}: ${start}`);
}

/** Each golden file holds what it must and nothing it must not. */
async function assertMigratedFiles(app: string, files: BedFile[]): Promise<void> {
  const failures: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await Deno.readTextFile(join(app, file.path));
    } catch {
      failures.push(`${file.path}: missing`);
      continue;
    }
    for (const want of file.contains ?? []) {
      if (!text.includes(want)) failures.push(`${file.path}: lacks ${JSON.stringify(want)}`);
    }
    for (const gone of file.absent ?? []) {
      if (text.includes(gone)) failures.push(`${file.path}: still has ${JSON.stringify(gone)}`);
    }
  }
  assertEquals(failures, [], "migrated files differ from the bed's goldens");
}

/** Clone → install → prepare → migrate → afterMigrate → build → serve → render-assert → doctor (informational). */
export async function runBed(t: Deno.TestContext, bed: Bed): Promise<void> {
  const { dir, skip } = await cloneAt(bed);
  try {
    if (skip) {
      console.warn(`migration-bed ${bed.name}: skipping — ${skip}`);
      return;
    }
    const app = bed.subdir ? join(dir, bed.subdir) : dir;

    if (!(await runCommands(bed, bed.install, app))) return;
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
      if (bed.start) assertStartPermissions(app, bed.start);
      if (bed.files) await assertMigratedFiles(app, bed.files);
    });
    // Every later step resolves under a one-day hold, `jsr:@denext/*` excluded (_dep-age.ts):
    // never `DENEXT_MIN_DEP_AGE=0`, which let a minutes-old npm release reach the build.
    await holdBedDependencies(app);

    if (bed.afterMigrate && !(await runCommands(bed, bed.afterMigrate, app))) return;
    await bed.afterMigrateEdit?.(app);

    await t.step("denext build", async () => {
      const r = await denext(["build", "."], app, BUILD_TIMEOUT_MS);
      assert(r.ok, `build failed:\n${r.out}`);
    });

    const server = await startCliServer(app, READY_TIMEOUT_MS);
    try {
      await t.step("routes render", async () => {
        const failures: string[] = [];
        for (const route of bed.routes) {
          const res = await fetch(server.origin + route.path, {
            redirect: "manual",
            headers: route.headers,
          });
          const body = await res.text();
          const want = route.status ?? 200;
          const location = res.headers.get("location") ?? "";
          if (res.status !== want) {
            failures.push(`${route.path}: status ${res.status}, expected ${want}`);
          } else if (!body.includes(route.contains)) {
            failures.push(
              `${route.path}: body lacks ${JSON.stringify(route.contains)} (${body.length} bytes)`,
            );
          } else if (route.location !== undefined && !location.includes(route.location)) {
            failures.push(
              `${route.path}: Location ${JSON.stringify(location)} lacks ${
                JSON.stringify(route.location)
              }`,
            );
          }
        }
        assertEquals(failures, [], `${bed.name}: route assertions failed`);
      });
      if (bed.browser) {
        const check = bed.browser;
        await t.step("the page hydrates in headless Chromium", () => browserCheck(server, check));
      }
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

/** Open `check.path`, wait for it to hydrate, then (optionally) navigate on the client. */
async function browserCheck(server: { origin: string }, check: BedBrowserCheck): Promise<void> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage(server.origin + check.path);
    await pollFor(page, check.hydrated, READY_TIMEOUT_MS);
    if (check.interact) {
      await act(page, check.interact, "reloaded the page instead of updating it");
    }
    if (check.navigate) {
      await act(page, check.navigate, "reloaded the page instead of navigating on the client");
    }
  } finally {
    await browser.close();
  }
}

/** Perform `action` on the page and wait for it to take, on the same document. */
async function act(page: Page, action: BedAction, reloaded: string): Promise<void> {
  await page.evaluate("globalThis.__bedSameDocument = true");
  if (action.press) await page.evaluate(action.press);
  else await (await page.$(action.click!))!.click();
  await pollFor(page, action.until, READY_TIMEOUT_MS);
  assert(
    await page.evaluate("globalThis.__bedSameDocument === true"),
    `${action.click ?? action.press} ${reloaded}`,
  );
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
