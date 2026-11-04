// The TypeScript 7 diagnostic diff: type-check the repo and its examples twice on denext's Deno
// toolchain, once with the in-process TypeScript 6 (`DENEXT_NATIVE_CHECK=0`) and once with the
// native TypeScript 7 checker (`DENEXT_NATIVE_CHECK=1`), normalize both sets of diagnostics and
// report what differs: a diagnostic only one compiler reports, or the same code at the same place
// with another message.
//
//   deno task ts7:diff                              # the repo (cli.ts, mod.ts, packages) + every example
//   deno task ts7:diff examples/hello examples/spa  # only these targets
//   deno task ts7:diff --out ts7-diff.md --json ts7-diff.json --fail-on-diff
//
// A target is a directory (checked with a bare `deno check`, every module under it) or `.` (the
// repo's own entry points). Each leg pins its engine: `DENEXT_NATIVE_CHECK=0` is the in-process
// TypeScript 6 (`DENO_CHECK_ENGINE=tsc`), `DENEXT_NATIVE_CHECK=1` the native checker
// (`DENO_CHECK_ENGINE=native`, which the runtime refuses to run without its verified compiler, so
// a TS7 leg never falls back to TS6 in silence). The toolchain is the pinned build
// `scripts/test-run.ts` resolves; `--deno <path>` names another (CI: the one on PATH).
//
// Dispatch-only in CI (.github/workflows/ts7-diff.yml): a report, never a gate on a push.

import { dirname, fromFileUrl, join, relative, resolve, SEPARATOR } from "@std/path";
import { toolchainDeno } from "./test-run.ts";

// The real path: the checker prints real paths (macOS's /var is /private/var).
const REPO = Deno.realPathSync(fromFileUrl(new URL("..", import.meta.url)));

/** The repo's own entry points (the CI `Type check` step's, plus every workspace package's). */
const REPO_ENTRIES = ["cli.ts", "mod.ts"];

/** One normalized diagnostic. */
export interface Diagnostic {
  /** `TS2322`, or `""` for an error Deno reports without a TypeScript code. */
  code: string;
  /** The file, relative to the repo root with `/` separators, or `""` when none was printed. */
  file: string;
  line: number;
  column: number;
  /** The message's first line, whitespace collapsed. */
  message: string;
}

/** Which compiler a diagnostic came from. */
export type Engine = "ts6" | "ts7";

/** What {@linkcode diffDiagnostics} found for one target. */
export interface TargetDiff {
  target: string;
  /** Reported by TypeScript 6 only. */
  onlyTs6: Diagnostic[];
  /** Reported by TypeScript 7 only. */
  onlyTs7: Diagnostic[];
  /** The same code at the same place with another message. */
  changed: { ts6: Diagnostic; ts7: Diagnostic }[];
  /** The diagnostic counts of each leg. */
  counts: Record<Engine, number>;
}

// deno-lint-ignore no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const HEAD = /^(?:(TS\d+) )?\[ERROR\]: (.*)$/;
const AT = /^\s+at (\S+?):(\d+):(\d+)\s*$/;
const FILE_URL = /file:\/\/[^\s'"`]+/g;

/**
 * Parse `deno check`'s output into diagnostics: each `TSnnnn [ERROR]: message` line, placed by the
 * first `at <file>:<line>:<col>` line after it. File URLs and absolute paths under `root` become
 * repo-relative `/`-separated paths, so two runs (or two machines) compare equal.
 *
 * @param output The command's combined output.
 * @param root The repo root the paths are made relative to.
 * @returns The diagnostics, in output order.
 */
export function parseDiagnostics(output: string, root: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  let pending: Diagnostic | null = null;
  const flush = () => {
    if (pending) out.push(pending);
    pending = null;
  };
  for (const raw of output.replace(ANSI, "").split(/\r?\n/)) {
    const head = HEAD.exec(raw.trim());
    if (head) {
      flush();
      pending = {
        code: head[1] ?? "",
        file: "",
        line: 0,
        column: 0,
        message: head[2]
          .replace(FILE_URL, (url) => normalizeFile(url, root))
          .replace(/\s+/g, " ")
          .trim(),
      };
      continue;
    }
    const at = AT.exec(raw);
    if (at && pending && pending.file === "") {
      pending.file = normalizeFile(at[1], root);
      pending.line = Number(at[2]);
      pending.column = Number(at[3]);
    }
  }
  flush();
  return out;
}

/** A printed location as a repo-relative, `/`-separated path. */
function normalizeFile(location: string, root: string): string {
  let path = location;
  if (path.startsWith("file://")) {
    try {
      path = fromFileUrl(path);
    } catch {
      return path;
    }
  }
  if (!path.startsWith(root)) return path;
  return relative(root, path).split(SEPARATOR).join("/");
}

const where = (d: Diagnostic) => `${d.code}|${d.file}|${d.line}|${d.column}`;
const key = (d: Diagnostic) => `${where(d)}|${d.message}`;

/**
 * Compare two legs' diagnostics. Equal ones (code, place and message) cancel out, a repeat
 * counting once per occurrence; what is left at the same code and place on both sides is a
 * changed message; the rest is reported by one compiler only.
 *
 * @param target The target's name (for the report).
 * @param ts6 TypeScript 6's diagnostics.
 * @param ts7 TypeScript 7's diagnostics.
 * @returns The differences.
 */
export function diffDiagnostics(target: string, ts6: Diagnostic[], ts7: Diagnostic[]): TargetDiff {
  const remaining7 = new Map<string, Diagnostic[]>();
  for (const d of ts7) remaining7.set(key(d), [...(remaining7.get(key(d)) ?? []), d]);
  const left6: Diagnostic[] = [];
  for (const d of ts6) {
    const same = remaining7.get(key(d));
    if (same?.length) same.pop();
    else left6.push(d);
  }
  const left7 = [...remaining7.values()].flat();
  const changed: TargetDiff["changed"] = [];
  const onlyTs6: Diagnostic[] = [];
  for (const d of left6) {
    const i = left7.findIndex((e) => where(e) === where(d));
    if (i >= 0) changed.push({ ts6: d, ts7: left7.splice(i, 1)[0] });
    else onlyTs6.push(d);
  }
  const order = (a: Diagnostic, b: Diagnostic) => key(a).localeCompare(key(b));
  return {
    target,
    onlyTs6: onlyTs6.sort(order),
    onlyTs7: left7.sort(order),
    changed,
    counts: { ts6: ts6.length, ts7: ts7.length },
  };
}

/** Whether a target's diff is empty. */
export function isClean(diff: TargetDiff): boolean {
  return diff.onlyTs6.length === 0 && diff.onlyTs7.length === 0 && diff.changed.length === 0;
}

const show = (d: Diagnostic) =>
  `${d.file || "(no file)"}${d.line ? `:${d.line}:${d.column}` : ""} ${d.code} ${d.message}`.trim();

/**
 * The Markdown report over every target's diff.
 *
 * @param diffs One per target.
 * @param versions The two compilers' versions, when known.
 * @returns The report.
 */
export function formatReport(diffs: TargetDiff[], versions: Record<Engine, string>): string {
  const lines = [
    "# TypeScript 6 vs 7 diagnostics",
    "",
    `TypeScript 6: ${versions.ts6} (\`DENEXT_NATIVE_CHECK=0\`); TypeScript 7: ${versions.ts7} ` +
    "(`DENEXT_NATIVE_CHECK=1`).",
    "",
    "| Target | TS6 | TS7 | Only TS6 | Only TS7 | Message changed |",
    "| --- | --: | --: | --: | --: | --: |",
    ...diffs.map((d) =>
      `| ${d.target} | ${d.counts.ts6} | ${d.counts.ts7} | ${d.onlyTs6.length} | ` +
      `${d.onlyTs7.length} | ${d.changed.length} |`
    ),
  ];
  const differing = diffs.filter((d) => !isClean(d));
  if (differing.length === 0) {
    lines.push("", "No differences.");
    return lines.join("\n") + "\n";
  }
  for (const d of differing) {
    lines.push("", `## ${d.target}`);
    if (d.onlyTs6.length) {
      lines.push(
        "",
        "Only TypeScript 6:",
        "",
        ...d.onlyTs6.map((x) => `- ${show(x)}`),
      );
    }
    if (d.onlyTs7.length) {
      lines.push(
        "",
        "Only TypeScript 7:",
        "",
        ...d.onlyTs7.map((x) => `- ${show(x)}`),
      );
    }
    if (d.changed.length) {
      lines.push("", "Message changed:", "");
      for (const { ts6, ts7 } of d.changed) {
        lines.push(`- ${show(ts6)}`, `  - TS7: ${ts7.message}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

/** The targets checked by default: the repo itself, then every example with its own deno.json. */
async function defaultTargets(): Promise<string[]> {
  const examples: string[] = [];
  for await (const entry of Deno.readDir(join(REPO, "examples"))) {
    if (!entry.isDirectory || entry.name.startsWith("_")) continue;
    try {
      await Deno.stat(join(REPO, "examples", entry.name, "deno.json"));
      examples.push(`examples/${entry.name}`);
    } catch { /* not a Deno project of its own */ }
  }
  return [".", ...examples.sort()];
}

/** The workspace packages' entry modules (`packages/<name>/mod.ts`). */
async function packageEntries(): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(join(REPO, "packages"))) {
    const mod = join("packages", entry.name, "mod.ts");
    try {
      if ((await Deno.stat(join(REPO, mod))).isFile) out.push(mod);
    } catch { /* no mod.ts */ }
  }
  return out.sort();
}

/** One `deno check` leg over a target. */
async function checkLeg(
  deno: string,
  target: string,
  engine: Engine,
): Promise<{ diagnostics: Diagnostic[]; code: number; tail: string }> {
  const cwd = resolve(REPO, target);
  const args = target === "." ? ["check", ...REPO_ENTRIES, ...(await packageEntries())] : ["check"];
  const { code, stdout, stderr } = await new Deno.Command(deno, {
    args,
    cwd,
    env: {
      DENEXT_NATIVE_CHECK: engine === "ts7" ? "1" : "0",
      DENO_CHECK_ENGINE: engine === "ts7" ? "native" : "tsc",
      NO_COLOR: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
  return {
    diagnostics: parseDiagnostics(text, REPO),
    code,
    tail: text.trim().split("\n").slice(-5).join("\n"),
  };
}

/**
 * The two compilers' versions: the in-process one from `deno --version`, the native one from the
 * toolchain's `typescript-check/tsc` beside `deno`.
 */
async function versions(deno: string): Promise<Record<Engine, string>> {
  const run = async (bin: string) => {
    try {
      const { stdout } = await new Deno.Command(bin, { args: ["--version"], stdout: "piped" })
        .output();
      return new TextDecoder().decode(stdout);
    } catch {
      return "";
    }
  };
  const ts6 = /typescript ([\d.]+)/i.exec(await run(deno))?.[1] ?? "?";
  const native = join(
    dirname(deno),
    "typescript-check",
    Deno.build.os === "windows" ? "tsc.exe" : "tsc",
  );
  const ts7 = /Version ([\w.-]+)/.exec(await run(native))?.[1] ?? "?";
  return { ts6, ts7 };
}

/** Parse the CLI: targets, `--deno`, `--out`, `--json`, `--fail-on-diff`. */
function parseArgs(args: string[]) {
  const opts = { targets: [] as string[], deno: "", out: "", json: "", failOnDiff: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--deno") opts.deno = args[++i];
    else if (a === "--out") opts.out = args[++i];
    else if (a === "--json") opts.json = args[++i];
    else if (a === "--fail-on-diff") opts.failOnDiff = true;
    else if (a.startsWith("--")) throw new Error(`ts7-diff: unknown option ${a}`);
    else opts.targets.push(a);
  }
  return opts;
}

if (import.meta.main) {
  const opts = parseArgs(Deno.args);
  const deno = opts.deno || await toolchainDeno();
  if (!deno) {
    console.error(
      "ts7-diff: DENEXT_DENO=stock has no native checker; run it on denext's toolchain.",
    );
    Deno.exit(2);
  }
  const targets = opts.targets.length ? opts.targets : await defaultTargets();
  const diffs: TargetDiff[] = [];
  for (const target of targets) {
    const [ts6, ts7] = [await checkLeg(deno, target, "ts6"), await checkLeg(deno, target, "ts7")];
    // A leg that failed without a single diagnostic did not type-check at all (a refused engine,
    // an unresolvable import): say so rather than report an empty diff.
    for (const [engine, leg] of [["ts6", ts6], ["ts7", ts7]] as const) {
      if (leg.code !== 0 && leg.diagnostics.length === 0) {
        leg.diagnostics.push({
          code: "",
          file: "",
          line: 0,
          column: 0,
          message: `${engine} run failed: ${leg.tail}`,
        });
      }
    }
    const diff = diffDiagnostics(target, ts6.diagnostics, ts7.diagnostics);
    console.error(
      `ts7-diff: ${target}: ts6 ${diff.counts.ts6}, ts7 ${diff.counts.ts7}` +
        (isClean(diff)
          ? ", same"
          : `, ${diff.onlyTs6.length}/${diff.onlyTs7.length}/${diff.changed.length} differ`),
    );
    diffs.push(diff);
  }
  const report = formatReport(diffs, await versions(deno));
  if (opts.out) await Deno.writeTextFile(opts.out, report);
  else console.log(report);
  if (opts.json) await Deno.writeTextFile(opts.json, JSON.stringify(diffs, null, 2) + "\n");
  if (opts.failOnDiff && diffs.some((d) => !isClean(d))) Deno.exit(1);
}
