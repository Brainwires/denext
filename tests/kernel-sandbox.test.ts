// The kernel sandbox's tooling (src/build/kernel-sandbox.ts): the runtime's `kernelSandbox`
// report, the machine's features, a command's grant, a warn run's log and the grant changes it
// sorts into, and `denext doctor`'s check.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  commandGrant,
  grantReport,
  type KernelSandboxInfo,
  kernelSandboxUpgradeNote,
  machineFeatures,
  parseKernelSandbox,
  parseWarnLog,
  renderGrantReport,
  reportStartupRefusals,
  ROLLOUT_DEFAULTS,
  sandboxVerdict,
  shellWords,
  START_TASK_KERNEL_SANDBOX,
  startTaskSandboxFlag,
} from "../src/build/kernel-sandbox.ts";
import { kernelSandboxCheck } from "../src/cli/commands/doctor.ts";
import { checkLines, statusLines, taskGrantLines } from "../src/cli/commands/kernel-sandbox.ts";

/** `deno info --json` on a Linux machine with Landlock ABI 4, no mode set (the preview). */
const LINUX_INFO = JSON.stringify({
  denoDir: "/home/me/.cache/deno",
  kernelSandbox: {
    preview: true,
    mode: "auto",
    source: "default",
    effective: "off",
    wouldApply: "warn",
    reason: "auto applies nothing yet (the kernel sandbox is an opt-in preview)",
    enforced: false,
    enforcerBuilt: true,
    osSandbox: "landlock",
    landlockAbi: 4,
    capabilities: {
      os: "linux",
      landlockAbi: 4,
      seccomp: true,
      userNamespaces: false,
      seatbelt: false,
      jobObject: false,
      lowIntegrity: false,
      enforcerBuilt: true,
    },
    features: ["fsRead", "fsWrite", "tcpPorts"],
    warnings: ["kernel sandbox: the supervising broker (Mode B) is not built in yet"],
  },
});

function info(patch: Record<string, unknown> = {}, caps: Record<string, unknown> = {}) {
  const root = JSON.parse(LINUX_INFO);
  Object.assign(root.kernelSandbox, patch);
  Object.assign(root.kernelSandbox.capabilities, caps);
  return parseKernelSandbox(JSON.stringify(root)) as KernelSandboxInfo;
}

Deno.test("parseKernelSandbox reads the report and tolerates what it doesn't know", () => {
  const ks = parseKernelSandbox(LINUX_INFO);
  assert(ks);
  assertEquals(ks.mode, "auto");
  assertEquals(ks.effective, "off");
  assertEquals(ks.wouldApply, "warn");
  // a runtime before the rollout stages reports none: the preview
  assertEquals(ks.stage, "preview");
  assertEquals(ks.capabilities.landlockAbi, 4);
  assertEquals(info({ stage: "r3" }).stage, "r3");
  // stock Deno, a runtime before the sandbox, garbage
  assertEquals(parseKernelSandbox(JSON.stringify({ denoDir: "/x" })), null);
  assertEquals(parseKernelSandbox("not json"), null);
  assertEquals(parseKernelSandbox(JSON.stringify({ kernelSandbox: { mode: "strict" } })), null);
});

Deno.test("machineFeatures says what each kernel feature gives and what is missing", () => {
  const features = machineFeatures(info());
  const landlock = features.find((f) => f.name === "Landlock ABI 4");
  assert(landlock?.present);
  assertStringIncludes(landlock.detail, "TCP port rules");
  assertStringIncludes(landlock.detail, "Not here: device ioctls");
  // the later ABIs are listed as absent, with the kernel that has them
  const abi6 = features.find((f) => f.name === "Landlock ABI 6");
  assertEquals(abi6?.present, false);
  assertStringIncludes(abi6!.detail, "Linux 6.12");
  assertEquals(features.find((f) => f.name === "unprivileged user namespaces")?.present, false);

  const none = machineFeatures(info({}, { landlockAbi: null }));
  assertEquals(none[0].present, false);
  assertStringIncludes(none[0].detail, "/sys/kernel/security/lsm");

  const mac = machineFeatures(info({ osSandbox: "seatbelt" }, { os: "macos", seatbelt: true }));
  assertEquals(mac.map((f) => [f.name, f.present]), [["Seatbelt", true]]);
  const win = machineFeatures(info({}, { os: "windows", jobObject: true, lowIntegrity: true }));
  assertEquals(win.map((f) => f.name), ["job object", "low integrity level"]);
});

Deno.test("sandboxVerdict says what applies to a run with no terminal", () => {
  assertStringIncludes(sandboxVerdict(info()), "nothing is applied in this release");
  assertStringIncludes(sandboxVerdict(info()), "a later release applies warn");
  assertStringIncludes(
    sandboxVerdict(info({ mode: "enforce", source: "config", effective: "enforce" })),
    "enforce from config: a run with no terminal is confined by the kernel (landlock)",
  );
  assertStringIncludes(
    sandboxVerdict(info({ stage: "r3", effective: "warn" })),
    "reports what the kernel would refuse and refuses nothing",
  );
  assertStringIncludes(
    sandboxVerdict(info({ mode: "off", source: "config", effective: "off", wouldApply: "off" })),
    "turned off for this project",
  );
  assertStringIncludes(sandboxVerdict(info({ enforcerBuilt: false })), "no kernel enforcer");
});

Deno.test("the defaults table has a value for every stage of every context", () => {
  for (const row of ROLLOUT_DEFAULTS) {
    for (const stage of ["preview", "r3", "r4"] as const) {
      assert(["off", "warn", "enforce"].includes(row[stage]), `${row.context} ${stage}`);
    }
    // the preview applies nothing anywhere, and a stage never loosens the one before it
    assertEquals(row.preview, "off", row.context);
    const rank = { off: 0, warn: 1, enforce: 2 } as Record<string, number>;
    assert(rank[row.r3] <= rank[row.r4], row.context);
  }
  // the one context that only warns at R3 is the bare run with no terminal
  assertEquals(ROLLOUT_DEFAULTS.filter((r) => r.r3 === "warn").length, 1);
});

Deno.test("commandGrant reads the permission flags of a task's deno run", () => {
  const start =
    "deno run --node-modules-dir=none --allow-net --allow-read --allow-env --allow-write=.denext " +
    "jsr:@denext/denext@^4/cli start . --port 8080";
  assertEquals(commandGrant(start), {
    flags: ["--allow-net", "--allow-read", "--allow-env", "--allow-write=.denext"],
    allowAll: false,
    mode: null,
  });
  // the program's own flags are not the command's
  assertEquals(commandGrant("deno run --allow-read main.ts --allow-net")?.flags, ["--allow-read"]);
  const all = commandGrant("deno run -A jsr:@denext/denext/cli start .");
  assertEquals(all?.allowAll, true);
  const enforced = commandGrant(
    'deno serve --kernel-sandbox=enforce --deny-read="/etc/my secrets" --no-prompt main.ts',
  );
  assertEquals(enforced?.mode, "enforce");
  assertEquals(enforced?.flags, [
    "--kernel-sandbox=enforce",
    "--deny-read=/etc/my secrets",
    "--no-prompt",
  ]);
  assertEquals(commandGrant("/opt/denext/bin/deno run --allow-ffi x.ts")?.flags, ["--allow-ffi"]);
  // a task that delegates has no grant to read
  assertEquals(commandGrant("denext start"), null);
  assertEquals(commandGrant("cd apps/web && deno task start"), null);
  assertEquals(shellWords(`a "b c" 'd e' "" f`), ["a", "b c", "d e", "", "f"]);
});

const LOG = [
  `{"type":"run","v":1,"pid":10,"os":"macos","policy":"1775641b2a5ce963","observer":"seatbelt-report","tag":"denext-ks:10-ab","since":1800000000}`,
  `{"type":"wouldDeny","v":1,"class":"startup","target":"--allow-net=example.com","source":"policy","note":"a host name needs the supervising broker"}`,
  `{"type":"wouldDeny","v":1,"class":"read","target":"/Users/me/.gitconfig","op":"file-read-data","source":"os","process":{"pid":11,"name":"git"},"grant":{"flag":"--allow-read","value":"/Users/me/.gitconfig"}}`,
  `{"type":"wouldDeny","v":1,"class":"read","target":"/Users/me/data","op":"file-read-data","source":"os","process":{"pid":10,"name":"deno"},"grant":{"flag":"--allow-read","value":"/Users/me/data"}}`,
  `{"type":"wouldDeny","v":1,"class":"read","target":"/Users/me/data/a.csv","op":"file-read-data","source":"os","process":{"pid":10,"name":"deno"},"grant":{"flag":"--allow-read","value":"/Users/me/data/a.csv"}}`,
  `{"type":"wouldDeny","v":1,"class":"read","target":"/Users/me/.npmrc","source":"os","process":{"pid":12,"name":"npm"},"grant":{"flag":"--allow-read","value":"/Users/me/.npmrc"},"note":"this path usually holds credentials"}`,
  `{"type":"wouldDeny","v":1,"class":"netConnect","target":"*:5432","op":"network-outbound","source":"os","process":{"pid":10,"name":"deno"},"grant":{"flag":"--allow-net","value":"<host>:5432"}}`,
  `{"type":"wouldDeny","v":1,"class":"service","target":"com.apple.windowserver.active","op":"mach-lookup","source":"os","process":{"pid":13,"name":"Chrome"},"note":"no permission grants this"}`,
  `{"type":"wouldDeny","v":1,"class":"exec","target":"sudo","source":"advisory","note":"it gains privileges through a setuid bit"}`,
  `{"type":"wouldDeny","v":2,"class":"read","target":"/from/a/later/format","source":"os"}`,
  `not json`,
  ``,
].join("\n");

Deno.test("parseWarnLog reads the known format and skips the rest", () => {
  const log = parseWarnLog(LOG);
  assertEquals(log.runs, [{
    pid: 10,
    os: "macos",
    policy: "1775641b2a5ce963",
    observer: "seatbelt-report",
  }]);
  assertEquals(log.events.length, 8);
  assertEquals(log.events[1].process, { pid: 11, name: "git" });
  assert(!log.events.some((e) => e.target === "/from/a/later/format"));
});

Deno.test("grantReport sorts a warn run into the changes to make", () => {
  const report = grantReport(parseWarnLog(LOG).events);
  assertEquals(report.startup.map((e) => e.target), ["--allow-net=example.com"]);
  assertEquals(report.ungrantable.map((e) => e.target), ["com.apple.windowserver.active"]);
  assertEquals(report.advisories.map((e) => e.target), ["sudo"]);
  assertEquals(report.changes.map((c) => c.flag), ["--allow-net", "--allow-read"]);
  const read = report.changes[1];
  // a path beneath another suggested path is folded into it
  assertEquals(read.values, ["/Users/me/.gitconfig", "/Users/me/.npmrc", "/Users/me/data"]);
  assertEquals(read.neededBy, ["deno", "git", "npm"]);
  assertEquals(read.cautions, ["/Users/me/.npmrc: this path usually holds credentials"]);
  assertEquals(grantReport([]).changes, []);
});

Deno.test("renderGrantReport prints flags, the deno.json form and the cautions", () => {
  const text = renderGrantReport(grantReport(parseWarnLog(LOG).events), true).join("\n");
  assertStringIncludes(text, "enforce would refuse to start");
  assertStringIncludes(text, "! --allow-net=example.com: a host name needs the supervising broker");
  assertStringIncludes(
    text,
    "--allow-read=/Users/me/.gitconfig,/Users/me/.npmrc,/Users/me/data   # needed by deno, git, npm",
  );
  assertStringIncludes(text, "caution: /Users/me/.npmrc: this path usually holds credentials");
  assertStringIncludes(text, `"net": ["<host>:5432"]`);
  assertStringIncludes(text, "<host>: the kernel reports the port, not the name");
  assertStringIncludes(text, "- mach-lookup com.apple.windowserver.active (Chrome)");
  assertStringIncludes(text, "- sudo: it gains privileges through a setuid bit");
  // nothing found: said differently where the run couldn't see native code and children
  assertStringIncludes(renderGrantReport(grantReport([]), true)[0], "Nothing would be refused");
  assertStringIncludes(renderGrantReport(grantReport([]), false)[0], "Nothing was reported");
});

Deno.test("the start task's sandbox flag is written only once it is turned on", () => {
  // denext 4.x writes none: its runtimes include ones that don't know the flag
  assertEquals(START_TASK_KERNEL_SANDBOX, null);
  assertEquals(startTaskSandboxFlag(), "");
  assertEquals(startTaskSandboxFlag("auto"), "--kernel-sandbox=auto ");
  // and the flag it would write is one commandGrant reads back as the task's own mode
  assertEquals(
    commandGrant(`deno run ${startTaskSandboxFlag("auto")}--allow-net main.ts`)?.mode,
    "auto",
  );
});

Deno.test("doctor's kernel sandbox check: features, verdict and the start task's dry run", async () => {
  const start = "deno run --allow-net=example.com:443 --allow-read jsr:@denext/denext/cli start .";
  let asked: readonly string[] | null = null;
  const held = await kernelSandboxCheck("/project", {
    info: info(),
    start,
    dryRun: (flags) => {
      asked = flags;
      return Promise.resolve({ report: "kernel sandbox (preview): …", startup: [] });
    },
  });
  assertEquals(asked, ["--allow-net=example.com:443", "--allow-read"]);
  assert(held?.ok);
  assertEquals(held.critical, false);
  assertStringIncludes(held.detail, "Landlock ABI 4, seccomp on linux");
  assertStringIncludes(held.detail, "every rule of the start task's grant can be held here");

  const refused = await kernelSandboxCheck("/project", {
    info: info(),
    start,
    dryRun: () =>
      Promise.resolve({
        report: "",
        startup: [{
          class: "startup",
          target: "--allow-net=example.com:443",
          source: "policy",
          note: "a host name needs the supervising broker",
        }],
      }),
  });
  assertEquals(refused?.ok, false);
  assertEquals(refused?.critical, false);
  assertStringIncludes(
    refused!.detail,
    "enforce would refuse to start the start task here: --allow-net=example.com:443 (a host " +
      "name needs the supervising broker)",
  );

  // -A: nothing to hold, and no dry run is made
  const all = await kernelSandboxCheck("/project", {
    info: info(),
    start: "deno run -A jsr:@denext/denext/cli start .",
    dryRun: () => {
      throw new Error("no dry run for -A");
    },
  });
  assert(all?.ok);
  assertStringIncludes(all.detail, "-A, which leaves nothing for the kernel to hold");

  // a runtime that reports no kernel sandbox: no check at all
  assertEquals(
    await kernelSandboxCheck("/project", {
      info: null,
      start,
      dryRun: () => Promise.resolve(null),
    }),
    null,
  );
});

Deno.test("reportStartupRefusals reads the report's marked gaps", () => {
  const report = [
    "kernel sandbox (preview): auto (default); applies: off; would apply: warn",
    "  gaps: 2 (1 refused by enforce, marked !)",
    "    sys [documented] no --allow-sys: sys is enforced by Deno; the kernel narrows: /proc/loadavg",
    "  ! enforcer [fail-open] --kernel-sandbox (broker): the supervising broker (Mode B) is not built into this runtime yet: one rule needs it",
  ].join("\n");
  assertEquals(reportStartupRefusals(report), [{
    class: "startup",
    target: "--kernel-sandbox (broker)",
    source: "policy",
    note: "the supervising broker (Mode B) is not built into this runtime yet: one rule needs it",
  }]);
  assertEquals(reportStartupRefusals("kernel sandbox (preview): off"), []);
});

Deno.test("the upgrade note names the tasks a later default would confine", () => {
  const note = kernelSandboxUpgradeNote({
    tasks: {
      start: "deno run --allow-net --allow-read --allow-env jsr:@denext/denext/cli start .",
      release: "deno run --allow-run=git --allow-read=. scripts/release.ts",
      native: { command: "deno run --allow-ffi --allow-read=. scripts/native.ts" },
      dev: "deno run -A jsr:@denext/denext/cli dev .",
      chosen: "deno run --kernel-sandbox=enforce --allow-run scripts/x.ts",
      shell: "sh scripts/build.sh",
    },
  });
  assert(note);
  assertStringIncludes(note[0], "the `release`, `native` tasks start programs or native code");
  assertStringIncludes(note[1], "denext kernel-sandbox check --task release");
  assertStringIncludes(note[2], "/docs/kernel-sandbox-migrating");
  // one task: singular
  assertStringIncludes(
    kernelSandboxUpgradeNote({ tasks: { ci: "deno run --allow-run ci.ts" } })![0],
    "the `ci` task starts programs",
  );
  // nothing to confine, a mode already chosen, no config
  assertEquals(
    kernelSandboxUpgradeNote({ tasks: { start: "deno run --allow-net main.ts" } }),
    null,
  );
  assertEquals(
    kernelSandboxUpgradeNote({
      permissions: { kernelSandbox: "warn" },
      tasks: { ci: "deno run --allow-run ci.ts" },
    }),
    null,
  );
  assertEquals(kernelSandboxUpgradeNote(null), null);
  assertEquals(kernelSandboxUpgradeNote({}), null);
});

Deno.test("status: the machine, what applies and the stage's defaults", () => {
  const text = statusLines(info({ stage: "r3" })).join("\n");
  assertStringIncludes(text, "This machine (linux):");
  assertStringIncludes(text, "✓ Landlock ABI 4:");
  assertStringIncludes(text, "✗ unprivileged user namespaces:");
  assertStringIncludes(text, "What applies: no setting:");
  assertStringIncludes(text, "note: the supervising broker (Mode B) is not built in yet");
  assertStringIncludes(text, "Defaults at this runtime's stage (r3), with no setting:");
  assertStringIncludes(text, "enforce  A compiled program (deno compile, denext build --compile)");
  assertStringIncludes(text, "warn     A bare deno run / serve with no terminal");
});

Deno.test("status: the task's grant, its dry run, and why there is none", () => {
  const grant = commandGrant("deno run --kernel-sandbox=auto --allow-read=. main.ts")!;
  const held = taskGrantLines({
    name: "start",
    command: "x",
    grant,
    dryRun: { report: "kernel sandbox (preview): …\n  policy 12ab", startup: [] },
  }).join("\n");
  assertStringIncludes(held, "The `start` task's grant:");
  assertStringIncludes(held, "    --kernel-sandbox=auto --allow-read=.");
  assertStringIncludes(held, "its own mode: --kernel-sandbox=auto");
  assertStringIncludes(held, "      policy 12ab");
  assertStringIncludes(held, "✓ every rule of this grant can be held here");

  const refused = taskGrantLines({
    name: "start",
    command: "x",
    grant,
    dryRun: {
      report: "r",
      startup: [{ class: "startup", target: "--allow-net=a", source: "policy" }],
    },
  }).join("\n");
  assertStringIncludes(refused, "✗ enforce would refuse to start: 1 rule(s)");

  const none = (task: Parameters<typeof taskGrantLines>[0]) => taskGrantLines(task).join("\n");
  assertStringIncludes(
    none({ name: "serve", command: null, grant: null, dryRun: null }),
    "deno.json has no `serve` task",
  );
  assertStringIncludes(
    none({ name: "start", command: "denext start", grant: null, dryRun: null }),
    "it starts no `deno run` / `deno serve` itself",
  );
  assertStringIncludes(
    none({ name: "start", command: "x", grant: commandGrant("deno run -A m.ts"), dryRun: null }),
    "-A: every permission",
  );
  const failed = none({
    name: "start",
    command: "x",
    grant: commandGrant("deno run m.ts"),
    dryRun: null,
  });
  assertStringIncludes(failed, "(no permission flags)");
  assertStringIncludes(failed, "the dry run failed");
});

Deno.test("check: what it prints after the run", () => {
  const report = grantReport(parseWarnLog(LOG).events);
  const seen = checkLines(report, 1, true, "macos").join("\n");
  assertStringIncludes(seen, "  Grants to add");
  assert(!seen.includes("could not see"));
  const blind = checkLines(grantReport([]), 1, false, "linux").join("\n");
  assertStringIncludes(blind, "Nothing was reported");
  assertStringIncludes(blind, "Linux has no report-only mode for Landlock.");
  assertStringIncludes(blind, "--kernel-sandbox=enforce where a failure is harmless");
  assertStringIncludes(
    checkLines(grantReport([]), 1, false, "macos").join("\n"),
    "no observer was applied.",
  );
  assertStringIncludes(
    checkLines(grantReport([]), 0, false, "linux").join("\n"),
    "No `deno` process of this run was in warn mode",
  );
});
