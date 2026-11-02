/**
 * Shared `deno doc` / `deno info` runner for the scripts and tests that read a module's
 * documentation or graph (`gen-api-reference.ts`, `gen-config-schema.ts`, the public-surface
 * golden, the parity extractors, the graph tests). Spawns the current `deno` binary so the output
 * matches the toolchain that runs the caller.
 *
 * On a loaded Windows CI runner such a child sometimes never exits (no output, no children of its
 * own), and an unbounded `output()` then holds the test file until the job's own timeout. So every
 * child here runs the way the build runs its `deno info` / `deno bundle` children
 * (src/build/serial-child.ts): one at a time in this process, killed at a deadline and started
 * once more, and a second stall is a named failure.
 *
 * To say where a stalled child was, each is probed (src/build/child-probe.ts, which the build's
 * own children use under `DENEXT_CHILD_PROBE=1`): it runs with Deno's debug log on (`DENO_LOG`,
 * minus the import map's and the permission checker's per-specifier lines), its stderr is kept as
 * a short tail in memory and printed only when the child stalls, with its CPU time sampled twice
 * before the kill (`Get-Process` on Windows, `ps` elsewhere), so a child blocked on a lock, a pipe
 * or the network reads differently from one that spins. A child that finishes costs only that tail.
 *
 * A `deno doc --json` / `deno info --json` child that has written a complete JSON document and then
 * stays silent without exiting (seen on Windows: a spin in the process's teardown) is killed after
 * a grace (`DENEXT_CHILD_EXIT_GRACE_MS`, 5 s) and its output used, with one line naming its pid.
 *
 * `deno doc --json` takes many modules at once, and {@linkcode denoDocJsonMany} documents them a
 * batch per child: a few children instead of one per module.
 *
 * @module
 */

import { resolve, toFileUrl } from "@std/path";
import { boundedSpawn, DENO_CHILD_LOG, type JsonStdout } from "../src/build/child-probe.ts";
import { childDeadlineMs, ChildStallError, retryOnStall } from "../src/build/serial-child.ts";

export { DENO_CHILD_LOG, sampleProcess } from "../src/build/child-probe.ts";

/** Each attempt's deadline unless `DENEXT_CHILD_DEADLINE_MS` replaces it: room for a cold cache. */
const DENO_CHILD_DEADLINE_MS = 120_000;

/** What {@linkcode boundedDeno} reports. */
export interface BoundedDenoResult {
  /** The exit code. */
  readonly code: number;
  /** It exited 0. */
  readonly success: boolean;
  /** Its stdout. */
  readonly stdout: string;
  /** Its stderr without the debug log's lines: what it would have printed without `DENO_LOG`. */
  readonly stderr: string;
}

/** Options for {@linkcode boundedDeno}. */
export interface BoundedDenoOptions {
  /** The working directory. */
  readonly cwd?: string;
  /**
   * Extra environment (a `DENO_LOG` here replaces {@linkcode DENO_CHILD_LOG}). Every child runs
   * with `NO_COLOR=1`: `deno doc --json` before denext's Deno 3.0.0-denext.7 (and on stock Deno)
   * otherwise writes ANSI colour codes into a type's `repr` even with its stdout piped.
   */
  readonly env?: Record<string, string>;
  /** Each attempt's deadline in ms (default 120 s, or `DENEXT_CHILD_DEADLINE_MS`). */
  readonly deadlineMs?: number;
  /** Where the retry notice (with the stalled attempt's report) goes (default: stderr). */
  readonly onStall?: (line: string) => void;
  /**
   * Whether the child's output is one JSON document on stdout, so that a child which wrote all of
   * it and then never exits is killed after a grace and its output used (child-probe.ts
   * `boundedSpawn`). Default: `{}` for `deno doc --json` and `deno info --json`, `false` otherwise.
   */
  readonly jsonStdout?: JsonStdout | false;
}

/** Whether `args` run a `deno doc --json` or `deno info --json`: one JSON document on stdout. */
function jsonDocument(args: readonly string[]): boolean {
  return (args[0] === "doc" || args[0] === "info") && args.includes("--json");
}

/** A `deno` child that was still running at its deadline on both attempts. */
export class DenoChildStallError extends Error {
  /** Each attempt's report: pid, CPU samples, output progress and the debug log's tail. */
  readonly attempts: readonly string[];
  /**
   * @param command The command line.
   * @param deadlineMs Each attempt's deadline.
   * @param attempts Each attempt's report.
   */
  constructor(command: string, deadlineMs: number, attempts: readonly string[]) {
    super(
      `${command} stalled: still running after ${deadlineMs / 1000} s on each of ` +
        `${attempts.length} attempts, and killed (DENEXT_CHILD_DEADLINE_MS raises the ` +
        `deadline).\n${attempts.join("\n")}`,
    );
    this.name = "DenoChildStallError";
    this.attempts = attempts;
  }
}

/**
 * Run `deno <args>` (or `program <args>`) to its exit, at most twice: an attempt still running at
 * its deadline is sampled, killed and started once more, in its turn of this process's serial
 * child queue ({@linkcode retryOnStall}). A second stall throws {@linkcode DenoChildStallError}
 * with both attempts' CPU samples and debug-log tails.
 *
 * @param args The arguments, e.g. `["doc", "--json", file]`.
 * @param options Working directory, environment, deadline.
 * @param program The executable (default `Deno.execPath()`; a test passes a stand-in).
 * @returns The exit code and output of the attempt that finished.
 */
export async function boundedDeno(
  args: readonly string[],
  options: BoundedDenoOptions = {},
  program: string = Deno.execPath(),
): Promise<BoundedDenoResult> {
  const deadlineMs = options.deadlineMs ?? childDeadlineMs(DENO_CHILD_DEADLINE_MS);
  const label = `deno ${args[0] ?? ""}`.trim();
  const reports: string[] = [];
  const jsonStdout = options.jsonStdout ?? (jsonDocument(args) ? {} : false);
  try {
    return await retryOnStall(
      label,
      args.slice(1),
      async (deadline) => {
        try {
          const out = await boundedSpawn(
            program,
            {
              args: [...args],
              cwd: options.cwd,
              env: { DENO_LOG: DENO_CHILD_LOG, NO_COLOR: "1", ...options.env },
              stdin: "null",
              stdout: "piped",
              stderr: "piped",
            },
            deadline,
            label,
            true,
            jsonStdout === false ? undefined : jsonStdout,
          );
          const dec = new TextDecoder();
          return {
            code: out.code,
            success: out.success,
            stdout: dec.decode(out.stdout),
            stderr: dec.decode(out.stderr),
          };
        } catch (err) {
          if (err instanceof ChildStallError && err.probe !== undefined) reports.push(err.probe);
          throw err;
        }
      },
      deadlineMs,
      options.onStall,
    );
  } catch (err) {
    if (!(err instanceof ChildStallError)) throw err;
    throw new DenoChildStallError(`deno ${args.join(" ")}`, deadlineMs, reports);
  }
}

/**
 * Run `deno doc --json` over `file` ({@linkcode boundedDeno}) and return the parsed document.
 *
 * @param file The module.
 * @param options Working directory, environment, deadline.
 * @returns The `deno doc --json` document.
 */
export async function denoDocJson(
  file: string,
  options: BoundedDenoOptions = {},
): Promise<unknown> {
  const { code, stdout, stderr } = await boundedDeno(["doc", "--json", file], options);
  if (code !== 0) throw new Error(`deno doc failed for ${file}: ${stderr}`);
  return JSON.parse(stdout);
}

/** How many modules one {@linkcode denoDocJsonMany} child documents. */
export const DOC_BATCH = 50;

/** The `deno doc --json` document's shape: one node per documented module. */
interface DocJson {
  readonly version?: unknown;
  readonly nodes?: Record<string, unknown>;
}

/** The key `deno doc --json` gives `file`'s node: its real path's `file:` URL. */
async function docKey(file: string, cwd: string | undefined): Promise<string> {
  const path = resolve(cwd ?? Deno.cwd(), file);
  return toFileUrl(await Deno.realPath(path).catch(() => path)).href;
}

/** A source position as `deno doc` writes one (`location`, a reference's `def.target`). */
interface DocPosition {
  readonly filename?: unknown;
  readonly line?: unknown;
  readonly col?: unknown;
}

/** `filename:line:col` of a position, or `undefined` when it isn't one. */
function positionKey(at: DocPosition | undefined): string | undefined {
  return typeof at?.filename === "string" ? `${at.filename}:${at.line}:${at.col}` : undefined;
}

/** What a module's node says about where its symbols are declared. */
interface NodePositions {
  /** The targets of its `reference` declarations into other files. */
  readonly refs: Set<string>;
  /** The positions of the declarations it describes. */
  readonly described: Set<string>;
}

/** A declaration's fields {@linkcode positionsOf} reads. */
interface DocDecl {
  readonly kind?: unknown;
  readonly location?: DocPosition;
  readonly def?: { readonly target?: DocPosition };
}

/** Add what `decl` says to `into`: a reference's target out of `self`, or where it is declared. */
function notePosition(decl: DocDecl, self: string, into: NodePositions): void {
  if (decl.kind !== "reference") {
    const at = positionKey(decl.location);
    if (at !== undefined) into.described.add(at);
    return;
  }
  const target = positionKey(decl.def?.target);
  if (target !== undefined && decl.def?.target?.filename !== self) into.refs.add(target);
}

/** `node`'s {@linkcode NodePositions}; `self` is its own file URL. */
function positionsOf(node: unknown, self: string): NodePositions {
  const into: NodePositions = { refs: new Set(), described: new Set() };
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (!Array.isArray(value)) notePosition(value as DocDecl, self, into);
    Object.values(value).forEach(walk);
  };
  walk(node);
  return into;
}

/**
 * `files` cut into batches of at most `size` in which no two modules are known to clash: each
 * module joins the first batch that has room and none of the modules it clashes with.
 */
function conflictFreeBatches(
  files: readonly string[],
  clashes: ReadonlyMap<string, ReadonlySet<string>>,
  size: number,
): string[][] {
  const batches: string[][] = [];
  for (const file of files) {
    const mine = clashes.get(file);
    const fits = batches.find((b) => b.length < size && !b.some((other) => mine?.has(other)));
    if (fits) fits.push(file);
    else batches.push([file]);
  }
  return batches;
}

/** The most rounds {@linkcode denoDocJsonMany} batches; what is left then is documented alone. */
const MAX_DOC_ROUNDS = 6;

/** What one batch settled, and what it leaves for a later round or for a run alone. */
interface BatchOutcome {
  /** The modules whose batched document is theirs alone. */
  readonly settled: [file: string, doc: unknown][];
  /** The modules to batch again, apart from the ones they clash with. */
  readonly again: string[];
  /** The modules to document alone. */
  readonly alone: string[];
  /** Pairs of modules that must not share a batch. */
  readonly clashes: [string, string][];
}

/**
 * Sort a batch's modules by their nodes: one with no reference into another file is settled. One
 * with such a reference clashes with every other module of the batch that describes or refers to
 * the same declaration (so two that both lost a symbol to a third are parted too) and is batched
 * again, unless no earlier module describes it: then it refers to that file even alone.
 */
function sortBatch(
  batch: readonly string[],
  keys: readonly string[],
  parsed: DocJson & { readonly nodes: Record<string, unknown> },
): BatchOutcome {
  const out: BatchOutcome = { settled: [], again: [], alone: [], clashes: [] };
  const positions = keys.map((k) => positionsOf(parsed.nodes[k], k));
  batch.forEach((file, i) => {
    const refs = [...positions[i].refs];
    if (refs.length === 0) {
      out.settled.push([file, {
        version: parsed.version,
        nodes: { [keys[i]]: parsed.nodes[keys[i]] },
      }]);
      return;
    }
    const describes = (j: number) => refs.some((r) => positions[j].described.has(r));
    if (!batch.some((_, j) => j < i && describes(j))) {
      out.alone.push(file);
      return;
    }
    batch.forEach((other, j) => {
      if (j !== i && (describes(j) || refs.some((r) => positions[j].refs.has(r)))) {
        out.clashes.push([file, other]);
      }
    });
    out.again.push(file);
  });
  return out;
}

/** Document `batch` in one child; a batch that fails, or lacks a module's node, goes alone. */
async function documentBatch(
  batch: readonly string[],
  options: BoundedDenoOptions,
): Promise<BatchOutcome> {
  const keys = await Promise.all(batch.map((f) => docKey(f, options.cwd)));
  const { code, stdout } = await boundedDeno(["doc", "--json", ...batch], options);
  const parsed = code === 0 ? JSON.parse(stdout) as DocJson : undefined;
  const nodes = parsed?.nodes;
  if (parsed === undefined || nodes === undefined || !keys.every((k) => Object.hasOwn(nodes, k))) {
    return { settled: [], again: [], alone: [...batch], clashes: [] };
  }
  return sortBatch(batch, keys, { ...parsed, nodes });
}

/** What {@linkcode denoDocJsonMany}'s rounds have found so far. */
interface DocRounds {
  /** The settled modules' documents. */
  readonly docs: Map<string, unknown>;
  /** The modules each must not share a batch with. */
  readonly clashes: Map<string, Set<string>>;
  /** The modules to document alone. */
  readonly alone: string[];
}

/** Record that `a` and `b` must not share a batch. */
function addClash(clashes: Map<string, Set<string>>, a: string, b: string): void {
  clashes.set(a, (clashes.get(a) ?? new Set()).add(b));
  clashes.set(b, (clashes.get(b) ?? new Set()).add(a));
}

/** One round: batch `pending` apart from its known clashes; returns the modules to batch again. */
async function docRound(
  pending: readonly string[],
  state: DocRounds,
  options: BoundedDenoOptions,
  batchSize: number,
): Promise<string[]> {
  const again: string[] = [];
  for (const batch of conflictFreeBatches(pending, state.clashes, batchSize)) {
    const out = batch.length === 1
      ? { settled: [], again: [], alone: batch, clashes: [] }
      : await documentBatch(batch, options);
    for (const [file, doc] of out.settled) state.docs.set(file, doc);
    for (const [a, b] of out.clashes) addClash(state.clashes, a, b);
    again.push(...out.again);
    state.alone.push(...out.alone);
  }
  return again;
}

/**
 * `deno doc --json` over each of `files`, as {@linkcode denoDocJson} returns it for that file
 * alone, from one child per {@linkcode DOC_BATCH} modules instead of one per module: each
 * module's document is `{ version, nodes: { "<its file URL>": <its node> } }`, cut from the
 * batch's.
 *
 * In one run `deno doc` describes a symbol once: a later module that exports it too gets a
 * `reference` to where it is declared, not the description it gets alone. So a module whose node
 * holds a reference into another file is documented again in a later round, never again batched
 * with the earlier modules that describe what it refers to. One whose reference no earlier module
 * of its batch explains (it has it alone too), and any left after {@linkcode MAX_DOC_ROUNDS}
 * rounds, is documented alone. A batch that fails, or whose output lacks one of its modules'
 * nodes, is documented one module at a time, so the result (or the error naming the module) is
 * the per-module path's.
 *
 * @param files The modules (a repeated one is documented once).
 * @param options Working directory, environment, deadline.
 * @param batchSize Modules per child.
 * @returns Each module's `deno doc --json` document, in the order of `files`.
 */
export async function denoDocJsonMany(
  files: readonly string[],
  options: BoundedDenoOptions = {},
  batchSize: number = DOC_BATCH,
): Promise<unknown[]> {
  const state: DocRounds = { docs: new Map(), clashes: new Map(), alone: [] };
  let pending = [...new Set(files)];
  for (let round = 0; pending.length > 0 && round < MAX_DOC_ROUNDS; round++) {
    pending = await docRound(pending, state, options, batchSize);
  }
  const { docs, alone } = state;
  for (const file of [...alone, ...pending]) docs.set(file, await denoDocJson(file, options));
  return files.map((f) => docs.get(f));
}
