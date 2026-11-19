// The kernel sandbox, as denext's tooling sees it: what the machine's kernel offers and what the
// sandbox would do (`deno info --json` → `kernelSandbox`), a dry run of the project's own `start`
// grant (the runtime's warn mode on an empty program: nothing of the app runs), and the grant
// changes a warn run reports (its JSON-lines log). `denext doctor`, `denext kernel-sandbox` and
// `denext upgrade` read it. Pure but for the three functions that start `deno`.
//
// Docs: https://denext.dev/docs/kernel-sandbox

/** The modes `--kernel-sandbox` and deno.json's `permissions.kernelSandbox` take. */
export type KernelSandboxMode = "off" | "warn" | "auto" | "enforce" | "broker";

/** How far the rollout of `auto` has come in a runtime. */
export type KernelSandboxStage = "preview" | "r3" | "r4";

/** `deno info --json` → `kernelSandbox`, the fields the tooling reads. */
export interface KernelSandboxInfo {
  readonly mode: KernelSandboxMode;
  readonly source: string;
  readonly effective: KernelSandboxMode;
  readonly wouldApply: "enforce" | "warn" | "off";
  /** Absent from a runtime before the rollout stages: the preview. */
  readonly stage: KernelSandboxStage;
  readonly reason: string;
  readonly enforcerBuilt: boolean;
  readonly osSandbox: string;
  readonly landlockAbi: number | null;
  readonly capabilities: {
    readonly os: string;
    readonly landlockAbi: number | null;
    readonly seccomp: boolean;
    readonly userNamespaces: boolean;
    readonly seatbelt: boolean;
    readonly jobObject: boolean;
    readonly lowIntegrity: boolean;
  };
  readonly features: readonly string[];
  readonly warnings: readonly string[];
}

const MODES: readonly string[] = ["off", "warn", "auto", "enforce", "broker"];

function bool(v: unknown): boolean {
  return v === true;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? v as Record<string, unknown> : {};
}

/** `v` when it is one of `allowed`, else `fallback`. */
function oneOf<T extends string, F>(v: unknown, allowed: readonly T[], fallback: F): T | F {
  return allowed.includes(v as T) ? v as T : fallback;
}

function parseCapabilities(v: unknown): KernelSandboxInfo["capabilities"] {
  const caps = record(v);
  return {
    os: str(caps.os, "other"),
    landlockAbi: numOrNull(caps.landlockAbi),
    seccomp: bool(caps.seccomp),
    userNamespaces: bool(caps.userNamespaces),
    seatbelt: bool(caps.seatbelt),
    jobObject: bool(caps.jobObject),
    lowIntegrity: bool(caps.lowIntegrity),
  };
}

/**
 * The `kernelSandbox` object of a `deno info --json` output.
 *
 * @param json The command's stdout.
 * @returns The report, or null when the runtime has none (stock Deno, a runtime before the
 * sandbox) or the output doesn't parse.
 */
export function parseKernelSandbox(json: string): KernelSandboxInfo | null {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return null;
  }
  const o = record(record(root).kernelSandbox);
  const modes = MODES as readonly KernelSandboxMode[];
  const mode = oneOf(o.mode, modes, null);
  const effective = oneOf(o.effective, modes, null);
  if (!mode || !effective) return null;
  return {
    mode,
    source: str(o.source, "default"),
    effective,
    wouldApply: oneOf(o.wouldApply, ["enforce", "warn"] as const, "off"),
    stage: oneOf(o.stage, ["r3", "r4"] as const, "preview"),
    reason: str(o.reason, ""),
    enforcerBuilt: bool(o.enforcerBuilt),
    osSandbox: str(o.osSandbox, "none"),
    landlockAbi: numOrNull(o.landlockAbi),
    capabilities: parseCapabilities(o.capabilities),
    features: strings(o.features),
    warnings: strings(o.warnings),
  };
}

/** One kernel feature of the machine: whether it is there and what that means for the sandbox. */
export interface MachineFeature {
  readonly name: string;
  readonly present: boolean;
  readonly detail: string;
}

/** What each Landlock ABI adds, in order: [ABI, kernel, what the sandbox gains]. */
const LANDLOCK_STEPS: readonly (readonly [number, string, string])[] = [
  [1, "5.13", "read, write and execute scopes"],
  [2, "5.19", "moving and linking files between granted folders"],
  [3, "6.2", "truncation held to the write scope"],
  [4, "6.7", "TCP port rules (a port list for IP addresses and localhost)"],
  [5, "6.10", "device ioctls held to the write scope"],
  [6, "6.12", "signals and abstract Unix sockets held inside the sandbox"],
  [7, "6.15", "refusals written to the audit log"],
];

function linuxFeatures(info: KernelSandboxInfo): MachineFeature[] {
  const abi = info.capabilities.landlockAbi;
  const out: MachineFeature[] = [];
  if (abi === null) {
    out.push({
      name: "Landlock",
      present: false,
      detail: "not available (a kernel before 5.13, Landlock missing from the kernel's `lsm=` " +
        "list, or a container whose seccomp profile refuses the landlock_* calls): file rules " +
        "can't be held, so enforce refuses to start; check `cat /sys/kernel/security/lsm`",
    });
  } else {
    const have = LANDLOCK_STEPS.filter(([n]) => n <= abi).map(([, , what]) => what);
    const next = LANDLOCK_STEPS.find(([n]) => n > abi);
    out.push({
      name: `Landlock ABI ${abi}`,
      present: true,
      detail: have.join("; ") +
        (next ? `. Not here: ${next[2]} (ABI ${next[0]}, Linux ${next[1]})` : ""),
    });
    for (const [n, kernel, what] of LANDLOCK_STEPS.filter(([n]) => n > abi)) {
      out.push({ name: `Landlock ABI ${n}`, present: false, detail: `${what} (Linux ${kernel})` });
    }
  }
  out.push({
    name: "seccomp",
    present: info.capabilities.seccomp,
    detail: info.capabilities.seccomp
      ? "socket families, the refused system-call list, no programs without --allow-run"
      : "this runtime has no seccomp program for this CPU architecture (x86_64 and aarch64 have)",
  });
  out.push({
    name: "unprivileged user namespaces",
    present: info.capabilities.userNamespaces,
    detail: info.capabilities.userNamespaces
      ? "a read deny inside a read allow can hide the denied path exactly"
      : "not allowed here (Ubuntu 23.10+ AppArmor, Docker's default profile): a read deny " +
        "inside a read allow is held by expansion, where files created after start are unreadable",
  });
  return out;
}

/**
 * The kernel features the sandbox uses, as this machine has them, each with what its presence or
 * absence means.
 *
 * @param info The runtime's report.
 * @returns One entry per mechanism of the machine's OS.
 */
export function machineFeatures(info: KernelSandboxInfo): MachineFeature[] {
  const os = info.capabilities.os;
  if (os === "linux") return linuxFeatures(info);
  if (os === "macos") {
    return [{
      name: "Seatbelt",
      present: info.capabilities.seatbelt,
      detail: info.capabilities.seatbelt
        ? "file, network, program and code-loading rules, denies inside allows held exactly; " +
          "port rules can't tell hosts apart"
        : "can't be applied here (this process already runs inside a sandbox, or neither " +
          "sandbox_init nor /usr/bin/sandbox-exec is available)",
    }];
  }
  if (os === "windows") {
    return [{
      name: "job object",
      present: info.capabilities.jobObject,
      detail: "the process tree is contained and ends together",
    }, {
      name: "low integrity level",
      present: info.capabilities.lowIntegrity,
      detail: "writes held to labelled folders; reads and the network stay with Deno's checks",
    }];
  }
  return [];
}

/**
 * The mode the `start` task that `denext create` and `denext migrate` write asks for, or null to
 * write none. `"auto"`, written out, is the author's choice: a runtime at rollout stage R3 or
 * later then confines `denext start` with the kernel, and falls back to warn mode (never a refusal
 * to start) where a rule can't be held; a preview-stage runtime applies nothing for it. Null while
 * denext 4.x supports runtimes that don't know the flag. Turning it on is this one line.
 */
export const START_TASK_KERNEL_SANDBOX: "auto" | null = null;

/**
 * The kernel-sandbox flag of a generated `start` command, with a trailing space, or the empty
 * string ({@link START_TASK_KERNEL_SANDBOX}).
 *
 * @param mode The mode to write (default: the constant).
 * @returns `"--kernel-sandbox=auto "` or `""`.
 */
export function startTaskSandboxFlag(mode: "auto" | null = START_TASK_KERNEL_SANDBOX): string {
  return mode ? `--kernel-sandbox=${mode} ` : "";
}

/** A row of the defaults table: a context and what `auto` applies to it at each stage. */
export interface RolloutRow {
  readonly context: string;
  readonly preview: string;
  readonly r3: string;
  readonly r4: string;
}

/**
 * What `auto` (no setting) applies, by context and rollout stage. `preview` is denext 4.x; `r3`
 * and `r4` are the two steps of denext 5.0's runtime line. The docs' table is this one.
 */
export const ROLLOUT_DEFAULTS: readonly RolloutRow[] = [
  {
    context: "A compiled program (`deno compile`, `denext build --compile`)",
    preview: "off",
    r3: "enforce",
    r4: "enforce",
  },
  {
    context: 'A packaged desktop app with `desktop.permissions: "strict"`',
    preview: "off",
    r3: "enforce",
    r4: "enforce",
  },
  {
    context: "`denext start` (and the Docker image / systemd unit that run it)",
    preview: "off",
    r3: "enforce",
    r4: "enforce",
  },
  {
    context: '`auto` written out (`--kernel-sandbox=auto`, `"kernelSandbox": "auto"`)',
    preview: "off",
    r3: "enforce",
    r4: "enforce",
  },
  {
    context: "A bare `deno run` / `serve` with no terminal (CI, a pipe) or `--no-prompt`",
    preview: "off",
    r3: "warn",
    r4: "enforce",
  },
  {
    context: "A run that can prompt (a terminal, prompting on)",
    preview: "off",
    r3: "off",
    r4: "off",
  },
  { context: "`-A` with no `--deny-*`", preview: "off", r3: "off", r4: "off" },
  {
    context: "`--watch`, HMR, `denext dev`, an external permission broker",
    preview: "off",
    r3: "off",
    r4: "off",
  },
];

/**
 * What the sandbox does for a run with no terminal on this machine, in one sentence: the line
 * `denext doctor` prints.
 *
 * @param info The runtime's report.
 * @returns The sentence.
 */
export function sandboxVerdict(info: KernelSandboxInfo): string {
  const where = info.source === "default" ? "no setting" : `${info.mode} from ${info.source}`;
  if (!info.enforcerBuilt) {
    return `${where}: this runtime has no kernel enforcer for ${info.capabilities.os}, so ` +
      "permissions are held by Deno's checks only";
  }
  if (info.effective === "enforce" || info.effective === "broker") {
    return `${where}: a run with no terminal is confined by the kernel (${info.osSandbox})`;
  }
  if (info.effective === "warn") {
    return `${where}: a run with no terminal reports what the kernel would refuse and refuses ` +
      "nothing";
  }
  if (info.mode === "off") return `${where}: the kernel sandbox is turned off for this project`;
  const later = info.wouldApply === "off"
    ? ""
    : `; a later release applies ${info.wouldApply} to a run with no terminal`;
  return `${where}: nothing is applied in this release (opt in with --kernel-sandbox=enforce ` +
    `on the start command)${later}`;
}

// ── The grant of a command ──────────────────────────────────────────────────────────────

/** Splits a task's command line into words, honouring single and double quotes. */
export function shellWords(command: string): string[] {
  // a word is a run of bare characters and quoted spans; a quoted span may be empty
  const out: string[] = [];
  for (const m of command.matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)) {
    out.push(m[0].replace(/"([^"]*)"|'([^']*)'/g, (_all, dq, sq) => dq ?? sq ?? ""));
  }
  return out;
}

const PERMISSION_FLAG =
  /^(--allow-[a-z-]+|--deny-[a-z-]+|--ignore-[a-z-]+|--allow-all|-A|--no-prompt|--kernel-sandbox(-exec)?)(=.*)?$/;

/** A `deno run` / `deno serve` command's permission flags. */
export interface CommandGrant {
  /** The permission flags, as written (`--allow-read=.`, `-A`, `--kernel-sandbox=enforce`). */
  readonly flags: readonly string[];
  /** `-A` / `--allow-all`. */
  readonly allowAll: boolean;
  /** The command's own `--kernel-sandbox` value, when it has one. */
  readonly mode: KernelSandboxMode | null;
}

/**
 * The permission flags of the first `deno run` / `deno serve` in a task's command line (the
 * `start` task: `deno run --allow-net … jsr:@denext/denext/cli start .`).
 *
 * @param command The task's command.
 * @returns The flags, or null when the command starts no `deno run` / `serve` (a task that
 * delegates, a shell script), whose grant can't be read from here.
 */
export function commandGrant(command: string): CommandGrant | null {
  const words = shellWords(command);
  const at = words.findIndex((w, i) =>
    (w === "run" || w === "serve") && i > 0 && /(^|[\\/])deno(\.exe)?$/.test(words[i - 1])
  );
  if (at < 0) return null;
  const flags: string[] = [];
  for (const word of words.slice(at + 1)) {
    if (!word.startsWith("-")) break; // the script: what follows is the program's own
    if (PERMISSION_FLAG.test(word)) flags.push(word);
  }
  const mode = flags.map((f) => /^--kernel-sandbox=(.*)$/.exec(f)?.[1]).find((m) => m);
  return {
    flags,
    allowAll: flags.some((f) => f === "-A" || f === "--allow-all"),
    mode: mode && MODES.includes(mode) ? mode as KernelSandboxMode : null,
  };
}

// ── A warn run's log ────────────────────────────────────────────────────────────────────

/** The grant that would allow an access. */
export interface Grant {
  readonly flag: string;
  readonly value?: string;
}

/** One access `enforce` would refuse (a `wouldDeny` line of a warn log). */
export interface WouldDeny {
  readonly class: string;
  readonly target: string;
  readonly op?: string;
  readonly source: string;
  readonly process?: { readonly pid: number; readonly name?: string };
  readonly grant?: Grant;
  readonly note?: string;
  /**
   * The OS's own libraries made the access and do without it when refused: logged, never a
   * grant to add.
   */
  readonly benign?: boolean;
}

/** A process of the run that reported (a `run` line of a warn log). */
export interface WarnRunRecord {
  readonly pid: number;
  readonly os: string;
  readonly policy?: string;
  /** `none`, `seatbelt-report`, `supervisor-trace`. */
  readonly observer: string;
}

/** What a warn log holds. */
export interface WarnLog {
  readonly runs: readonly WarnRunRecord[];
  readonly events: readonly WouldDeny[];
}

/** The log format this reader knows (the runtime's `WOULD_DENY_FORMAT`). */
const WARN_LOG_FORMAT = 1;

/** One line of a warn log as a record of the known format, or null. */
function warnLogRecord(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const rec = JSON.parse(line);
    return record(rec).v === WARN_LOG_FORMAT ? rec : null;
  } catch {
    return null;
  }
}

function runRecord(rec: Record<string, unknown>): WarnRunRecord | null {
  if (rec.type !== "run" || typeof rec.pid !== "number") return null;
  return {
    pid: rec.pid,
    os: str(rec.os, ""),
    ...(typeof rec.policy === "string" ? { policy: rec.policy } : {}),
    observer: str(rec.observer, "none"),
  };
}

function eventRecord(rec: Record<string, unknown>): WouldDeny | null {
  const ok = rec.type === "wouldDeny" && typeof rec.class === "string" &&
    typeof rec.target === "string";
  if (!ok) return null;
  const { v: _v, type: _t, ...event } = rec;
  return event as unknown as WouldDeny;
}

/**
 * Parses a warn run's JSON-lines log (`DENO_KERNEL_SANDBOX_WARN_LOG`). Lines that aren't a record
 * of the known format are skipped, so a log several runtime versions appended to still reads.
 *
 * @param text The file's text.
 * @returns The run records and the events, in file order.
 */
export function parseWarnLog(text: string): WarnLog {
  const runs: WarnRunRecord[] = [];
  const events: WouldDeny[] = [];
  for (const line of text.split("\n")) {
    const rec = warnLogRecord(line);
    if (!rec) continue;
    const run = runRecord(rec);
    if (run) runs.push(run);
    const event = eventRecord(rec);
    if (event) events.push(event);
  }
  return { runs, events };
}

/** One permission flag to change, with the values to add and who needed them. */
export interface GrantChange {
  /** `--allow-read`, `--allow-net`, … */
  readonly flag: string;
  /** The values to add to the flag's list, sorted; empty for an unscoped flag. */
  readonly values: readonly string[];
  /** The programs that needed it (`deno` is the program itself or native code in it). */
  readonly neededBy: readonly string[];
  /** Cautions the runtime attached (a path that usually holds credentials). */
  readonly cautions: readonly string[];
}

/** What a warn run found, sorted for a person to act on. */
export interface GrantReport {
  /** The grants to add, one entry per flag. */
  readonly changes: readonly GrantChange[];
  /** Rules `enforce` would refuse to start over on this machine. */
  readonly startup: readonly WouldDeny[];
  /** Accesses no grant allows. */
  readonly ungrantable: readonly WouldDeny[];
  /** Advisories about the programs the run started. */
  readonly advisories: readonly WouldDeny[];
  /** Accesses by the OS's own libraries that do without them: left out of everything above. */
  readonly benign: number;
}

/** Whether `path` is `dir` or lies beneath it. */
function beneath(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith("/") ? dir : dir + "/");
}

const PATH_FLAGS: readonly string[] = ["--allow-read", "--allow-write", "--allow-ffi"];

/** What the events ask of one flag. */
interface FlagNeeds {
  readonly values: Set<string>;
  readonly by: Set<string>;
  readonly cautions: Set<string>;
}

/** Adds a grantable event to its flag's needs. */
function addNeed(byFlag: Map<string, FlagNeeds>, event: WouldDeny, grant: Grant): void {
  let entry = byFlag.get(grant.flag);
  if (!entry) {
    byFlag.set(grant.flag, entry = { values: new Set(), by: new Set(), cautions: new Set() });
  }
  if (grant.value !== undefined) entry.values.add(grant.value);
  if (event.process?.name) entry.by.add(event.process.name);
  if (event.note) entry.cautions.add(`${event.target}: ${event.note}`);
}

/** One flag's change: its values sorted, a path beneath another suggested path folded into it. */
function grantChange(flag: string, needs: FlagNeeds): GrantChange {
  let values = [...needs.values].sort();
  if (PATH_FLAGS.includes(flag)) {
    values = values.filter((v) => !values.some((other) => other !== v && beneath(v, other)));
  }
  return { flag, values, neededBy: [...needs.by].sort(), cautions: [...needs.cautions].sort() };
}

/**
 * Sorts a warn run's events into the changes to make: per flag, the values to add (a path that
 * lies beneath another suggested path of the same flag is folded into it), then the rules enforce
 * would refuse to start over, the accesses no grant allows, and the advisories.
 *
 * @param events The log's events.
 * @returns The report.
 */
export function grantReport(events: readonly WouldDeny[]): GrantReport {
  const byFlag = new Map<string, FlagNeeds>();
  const startup: WouldDeny[] = [];
  const ungrantable: WouldDeny[] = [];
  const advisories: WouldDeny[] = [];
  let benign = 0;
  for (const event of events) {
    if (event.benign) benign++;
    else if (event.class === "startup") startup.push(event);
    else if (event.source === "advisory") advisories.push(event);
    else if (event.grant) addNeed(byFlag, event, event.grant);
    else ungrantable.push(event);
  }
  const changes = [...byFlag].sort(([a], [b]) => a.localeCompare(b)).map(([flag, needs]) =>
    grantChange(flag, needs)
  );
  return { changes, startup, ungrantable, advisories, benign };
}

/** The deno.json `permissions` key a flag's values go under. */
const CONFIG_KEYS: Readonly<Record<string, string>> = {
  "--allow-read": "read",
  "--allow-write": "write",
  "--allow-net": "net",
  "--allow-run": "run",
  "--allow-ffi": "ffi",
  "--allow-sys": "sys",
  "--allow-env": "env",
};

/** A titled section of the rendered report, followed by a blank line; nothing when empty. */
function section(title: string, lines: readonly string[]): string[] {
  return lines.length ? [title, ...lines, ""] : [];
}

/** `  ! rule: detail`, without a trailing colon's space when there is no detail. */
function noted(prefix: string, note: string | undefined): string {
  return `${prefix}: ${note ?? ""}`.trimEnd();
}

/** The "Grants to add" lines: each flag, its cautions, the deno.json form, the host note. */
function changeLines(changes: readonly GrantChange[]): string[] {
  const out: string[] = [];
  for (const c of changes) {
    const by = c.neededBy.length ? `   # needed by ${c.neededBy.join(", ")}` : "";
    out.push(c.values.length ? `  ${c.flag}=${c.values.join(",")}${by}` : `  ${c.flag}${by}`);
    for (const caution of c.cautions) out.push(`      caution: ${caution}`);
  }
  const config = changes.filter((c) => CONFIG_KEYS[c.flag] && c.values.length);
  if (config.length) {
    out.push("", '  or, in deno.json "permissions" (add to the set the command uses):');
    for (const c of config) out.push(`    "${CONFIG_KEYS[c.flag]}": ${JSON.stringify(c.values)}`);
  }
  if (changes.some((c) => c.values.some((v) => v.includes("<host>")))) {
    out.push(
      "",
      "  <host>: the kernel reports the port, not the name. Put the host the program " +
        "connects to there.",
    );
  }
  return out;
}

function ungrantableLine(e: WouldDeny): string {
  const who = e.process?.name ? ` (${e.process.name})` : "";
  return noted(`  - ${e.op ? e.op + " " : ""}${e.target}${who}`, e.note);
}

/** What the report says when a run reported nothing. */
function nothingLine(observed: boolean): string {
  return observed
    ? "Nothing would be refused: this run stays inside its grant under enforce."
    : "Nothing was reported. On this OS warn mode sees the policy and the runtime's own " +
      "decisions, not what native code and child processes do (see below).";
}

/**
 * The report as the lines `denext kernel-sandbox check` prints.
 *
 * @param report The sorted events.
 * @param observed Whether the run could see native code and child processes (false on Linux,
 * where warn mode sees only the policy and the runtime's own decisions).
 * @returns The lines, without a trailing newline.
 */
export function renderGrantReport(report: GrantReport, observed: boolean): string[] {
  const out = [
    ...section(
      "enforce would refuse to start (rules this machine's kernel can't hold):",
      report.startup.map((e) => noted(`  ! ${e.target}`, e.note)),
    ),
    ...section(
      "Grants to add (each allows something this run did that enforce would refuse):",
      changeLines(report.changes),
    ),
    ...section(
      "Refused whatever is granted (change the program, or keep this command out of enforce):",
      report.ungrantable.map(ungrantableLine),
    ),
    ...section(
      "Programs this run starts:",
      report.advisories.map((e) => noted(`  - ${e.target}`, e.note)),
    ),
  ];
  if (!out.length) out.push(nothingLine(observed), "");
  if (report.benign) {
    out.push(
      `(${report.benign} access(es) by the operating system's own libraries are left out: ` +
        "they do without them under enforce.)",
      "",
    );
  }
  out.pop(); // the last blank line
  return out;
}

// ── Running the runtime ─────────────────────────────────────────────────────────────────

/**
 * The machine's `kernelSandbox` report for the project (`deno info --json` in its directory, so
 * its deno.json's `permissions.kernelSandbox` counts).
 *
 * @param deno The `deno` executable the project runs on.
 * @param cwd The project directory.
 * @param timeoutMs How long to wait (default 15 s).
 * @returns The report, or null when the runtime has none or the command fails.
 */
export async function readKernelSandbox(
  deno: string,
  cwd: string,
  timeoutMs = 15_000,
): Promise<KernelSandboxInfo | null> {
  try {
    const out = await new Deno.Command(deno, {
      args: ["info", "--json"],
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(timeoutMs),
    }).output();
    return out.success ? parseKernelSandbox(new TextDecoder().decode(out.stdout)) : null;
  } catch {
    return null;
  }
}

/**
 * The rules a `--kernel-sandbox-report` marks `!` (enforce refuses to start over them), as startup
 * events: `  ! net [fail-open] --allow-net=example.com: <detail>`.
 *
 * @param report The report's text.
 * @returns One event per marked gap.
 */
export function reportStartupRefusals(report: string): WouldDeny[] {
  const out: WouldDeny[] = [];
  for (const line of report.split("\n")) {
    const m = /^\s*! \S+ \[fail-open\] (.+?): (.*)$/.exec(line);
    if (m) out.push({ class: "startup", target: m[1], source: "policy", note: m[2] });
  }
  return out;
}

/** An empty program: a dry run compiles the policy and runs nothing of the app. */
const EMPTY_PROGRAM = "data:application/javascript,";

/** What a dry run of a grant found. */
export interface DryRun {
  /** The runtime's `--kernel-sandbox-report` text (the mode, the machine, the policy, the gaps). */
  readonly report: string;
  /** The rules `enforce` would refuse to start over. */
  readonly startup: readonly WouldDeny[];
}

/**
 * A dry run of a grant on this machine: the runtime compiles the kernel policy for `flags` in warn
 * mode on an empty program and reports it. Nothing of the app runs, no observer is applied.
 *
 * @param deno The `deno` executable.
 * @param cwd The project directory.
 * @param flags The command's permission flags ({@link commandGrant}); its own `--kernel-sandbox`
 * flags are replaced.
 * @param timeoutMs How long to wait (default 30 s).
 * @returns The report and the startup refusals, or null when the run fails (a runtime without warn
 * mode's log, a flag the runtime refuses).
 */
export async function dryRunGrant(
  deno: string,
  cwd: string,
  flags: readonly string[],
  timeoutMs = 30_000,
): Promise<DryRun | null> {
  const log = await Deno.makeTempFile({ prefix: "denext-ks-", suffix: ".jsonl" });
  try {
    const out = await new Deno.Command(deno, {
      args: [
        "run",
        "--no-prompt",
        ...flags.filter((f) => !f.startsWith("--kernel-sandbox") && f !== "--no-prompt"),
        "--kernel-sandbox=warn",
        "--kernel-sandbox-report",
        EMPTY_PROGRAM,
      ],
      cwd,
      env: {
        DENO_KERNEL_SANDBOX_WARN_LOG: log,
        DENO_KERNEL_SANDBOX_WARN_OBSERVE: "0",
        NO_COLOR: "1",
      },
      stdin: "null",
      stdout: "null",
      stderr: "piped",
      signal: AbortSignal.timeout(timeoutMs),
    }).output();
    if (!out.success) return null;
    const report = new TextDecoder().decode(out.stderr);
    if (!report.includes("kernel sandbox")) return null;
    const { runs, events } = parseWarnLog(await Deno.readTextFile(log));
    // a runtime before warn mode's log writes none: its report's `!` lines say the same
    const startup = runs.length
      ? events.filter((e) => e.class === "startup")
      : reportStartupRefusals(report);
    return { report: report.trimEnd(), startup };
  } catch {
    return null;
  } finally {
    await Deno.remove(log).catch(() => {});
  }
}

/** What a warn run of a command found. */
export interface WarnRunResult {
  /** The command's exit code. */
  readonly code: number;
  readonly log: WarnLog;
  /** Whether a process of the run observed native code and child processes. */
  readonly observed: boolean;
}

/**
 * Runs `command` with the kernel sandbox in warn mode for every `deno` it starts
 * (`DENO_KERNEL_SANDBOX=warn`; a `--kernel-sandbox` flag in the command wins over it) and reads
 * what they reported. The command's output passes through; it runs until it ends, or until
 * `signal` aborts it (a server).
 *
 * @param command The program and its arguments.
 * @param cwd Where to run it.
 * @param signal Stops the command.
 * @returns The exit code and the log.
 */
export async function warnRun(
  command: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<WarnRunResult> {
  const log = await Deno.makeTempFile({ prefix: "denext-ks-", suffix: ".jsonl" });
  try {
    const child = new Deno.Command(command[0], {
      args: command.slice(1),
      cwd,
      env: { DENO_KERNEL_SANDBOX: "warn", DENO_KERNEL_SANDBOX_WARN_LOG: log },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const stop = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    };
    signal?.addEventListener("abort", stop, { once: true });
    const status = await child.status;
    signal?.removeEventListener("abort", stop);
    const parsed = parseWarnLog(await Deno.readTextFile(log));
    return {
      code: status.code,
      log: parsed,
      observed: parsed.runs.some((r) => r.observer !== "none"),
    };
  } finally {
    await Deno.remove(log).catch(() => {});
  }
}

// ── The upgrade note ────────────────────────────────────────────────────────────────────

/**
 * What `denext upgrade` says about the kernel sandbox for a project: the tasks whose `deno run` /
 * `deno serve` starts programs or loads native code under a partial grant with no mode chosen.
 * Those are the runs a later default confines; the note names them and the command that shows
 * what each would be refused. Null when there is nothing to say: no such task, or the project
 * already chose a mode (`permissions.kernelSandbox`, or the flag on the task).
 *
 * @param denoJson The project's parsed deno.json.
 * @returns The lines to print, or null.
 */
export function kernelSandboxUpgradeNote(
  denoJson: Record<string, unknown> | null,
): string[] | null {
  if (!denoJson) return null;
  const permissions = denoJson.permissions as Record<string, unknown> | undefined;
  if (typeof permissions?.kernelSandbox === "string") return null;
  const tasks = (denoJson.tasks ?? {}) as Record<string, unknown>;
  const names: string[] = [];
  for (const [name, task] of Object.entries(tasks)) {
    const command = typeof task === "string"
      ? task
      : (task as { command?: unknown } | null)?.command;
    if (typeof command !== "string") continue;
    const grant = commandGrant(command);
    if (!grant || grant.allowAll || grant.mode) continue;
    if (grant.flags.some((f) => /^--allow-(run|ffi)(=|$)/.test(f))) names.push(name);
  }
  if (!names.length) return null;
  const list = names.map((n) => `\`${n}\``).join(", ");
  return [
    `Kernel sandbox: the ${list} task${names.length === 1 ? " starts" : "s start"} programs or ` +
    "native code under a fixed grant. A later release holds such runs' child processes and " +
    "native code to that grant with the kernel.",
    `  See what would be refused, with nothing refused: denext kernel-sandbox check --task ${
      names[0]
    }`,
    "  Guide: https://denext.dev/docs/kernel-sandbox-migrating",
  ];
}
