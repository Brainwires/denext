// examples/hangar's VM logic (lib/), against an in-memory host (tests/helpers/hangar-fake-host.ts):
// start.sh reading, the Hangar VM config and its QEMU command line, process matching, the library's
// file rules, start / shutdown / force stop, the image actions, the tray's placement and menu, and
// the QMP client over an in-memory socket. Nothing here starts QEMU or touches ~/VMs.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { fromFileUrl } from "@std/path";
import { boundedDeno } from "../scripts/deno-doc.ts";
import { FakeHost } from "./helpers/hangar-fake-host.ts";
import {
  formatBytes,
  overBudgetBy,
  parseSize,
  ramBudget,
  rdpAddress,
  sshCommand,
  trayTooltip,
} from "../examples/hangar/lib/format.ts";
import {
  createHangar,
  defaultSettings,
  HangarError,
  parseSettings,
} from "../examples/hangar/lib/hangar.ts";
import { parseImageInfo, sizeBytes } from "../examples/hangar/lib/images.ts";
import { readVmFile, scanLibrary } from "../examples/hangar/lib/library.ts";
import {
  isQemuSystem,
  matchInstances,
  parsePidFile,
  parsePs,
} from "../examples/hangar/lib/processes.ts";
import { openQmpSession, QmpError } from "../examples/hangar/lib/qmp.ts";
import {
  expandScriptVariables,
  parseMemoryMiB,
  parseStartScript,
} from "../examples/hangar/lib/start-script.ts";
import { MENU, SHUTDOWN_PREFIX, trayMenu } from "../examples/hangar/lib/tray.ts";
import type { Overview, VmDefinition } from "../examples/hangar/lib/types.ts";
import {
  buildQemuCommand,
  ConfigError,
  type HangarVmConfig,
  parseVmConfig,
} from "../examples/hangar/lib/vm-config.ts";

const ROOT = "/home/u/VMs";
const QEMU_A64 = "/opt/homebrew/bin/qemu-system-aarch64";

/** The headless-capable start.sh shape (an aarch64 Linux guest). */
const LINUX_SCRIPT = `#!/bin/bash
# linux-arm: 4 cores, 6 GB RAM. SSH: ssh -p 2224 user@localhost
cd "$(dirname "$0")"
rm -f qmp.sock
display=(-display cocoa)
if [ "\${LAB_HEADLESS:-}" = 1 ]; then
  display=(-display none -daemonize -pidfile "$PWD/qemu.pid")
fi
exec ${QEMU_A64} \\
  -name "linux-arm" \\
  -M virt,highmem=on -accel hvf -cpu host -smp \${SMP:-4} -m \${MEM:-6G} \\
  -drive if=pflash,format=raw,readonly=on,file=/opt/homebrew/share/qemu/edk2-aarch64-code.fd \\
  -drive if=pflash,format=raw,file=vars.fd \\
  -drive file=disk.qcow2,if=virtio,format=qcow2,discard=unmap \\
  -nic user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:2224-:22 \\
  -qmp unix:qmp.sock,server=on,wait=off \\
  "\${display[@]}"
`;

/** The other shape: a variable for the binary, a quoted name with spaces, no headless mode. */
const WINDOWS_SCRIPT = `#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
QEMU=/opt/homebrew/bin/qemu-system-x86_64
cdroms=()
if [ -f windows.iso ]; then
  cdroms+=(-drive file=windows.iso,media=cdrom,if=none,id=cd0,readonly=on)
fi
exec "$QEMU" \\
  -name "Windows 11 x64" \\
  -M q35 -accel tcg,thread=multi,tb-size=1024 \\
  -smp 6 -m 8G \\
  -drive file=disk.qcow2,if=none,id=hd0,format=qcow2,discard=unmap \\
  "\${cdroms[@]}" \\
  -nic user,model=e1000e,hostfwd=tcp:127.0.0.1:3390-:3389,hostfwd=tcp:127.0.0.1:2227-:22 \\
  -qmp unix:qmp.sock,server=on,wait=off \\
  -display cocoa
`;

const CONFIG: HangarVmConfig = {
  version: 1,
  name: "Test VM",
  arch: "aarch64",
  accel: "hvf",
  cpus: 2,
  memoryMiB: 2048,
  disks: [{ file: "disk.qcow2", interface: "virtio" }],
  iso: null,
  nics: [{
    model: "virtio-net-pci",
    forwards: [{ proto: "tcp", hostAddress: "127.0.0.1", hostPort: 2300, guestPort: 22 }],
  }],
  display: "cocoa",
};

/** A library with an adopted Linux VM, an adopted Windows VM and a Hangar VM. */
function library(): FakeHost {
  return new FakeHost()
    .file(`${ROOT}/linux-arm/start.sh`, LINUX_SCRIPT)
    .file(`${ROOT}/linux-arm/disk.qcow2`, "x".repeat(100))
    .file(`${ROOT}/linux-arm/credentials.txt`, "secret")
    .file(`${ROOT}/windows-x64/start.sh`, WINDOWS_SCRIPT)
    .file(`${ROOT}/windows-x64/disk.qcow2`, "x")
    .file(`${ROOT}/windows-x64/windows.iso`, "x")
    .file(`${ROOT}/mine/hangar.json`, JSON.stringify(CONFIG))
    .file(`${ROOT}/mine/disk.qcow2`, "x")
    .file(`${ROOT}/not-a-vm/notes.txt`, "x");
}

function hangarOn(host: FakeHost) {
  return createHangar(host, defaultSettings(host.home, host.os));
}

/** `qemu-img info --output=json` for a 10 GiB qcow2 with one snapshot. */
const INFO_JSON = JSON.stringify({
  format: "qcow2",
  "virtual-size": 10 * 1024 ** 3,
  "actual-size": 1024 ** 3,
  "backing-filename": "/home/u/VMs/base/base.qcow2",
  snapshots: [{ id: "1", name: "clean", "date-sec": 1700000000, "vm-state-size": 0 }],
});

// --- start.sh -------------------------------------------------------------------------------

Deno.test("hangar start.sh: the headless-capable shape", () => {
  const vm = parseStartScript("linux-arm", `${ROOT}/linux-arm`, LINUX_SCRIPT);
  assertEquals(vm.name, "linux-arm");
  assertEquals(vm.arch, "aarch64");
  assertEquals(vm.accel, "hvf");
  assertEquals(vm.cpus, 4);
  assertEquals(vm.memoryMiB, 6144);
  assertEquals(vm.disks, ["disk.qcow2"]); // pflash drives are firmware, not disks
  assertEquals(vm.qmpSocket, `${ROOT}/linux-arm/qmp.sock`);
  assertEquals(vm.pidFile, `${ROOT}/linux-arm/qemu.pid`);
  assert(vm.headlessCapable);
  assertEquals(vm.forwards, [{
    proto: "tcp",
    hostAddress: "127.0.0.1",
    hostPort: 2224,
    guestPort: 22,
  }]);
  assertEquals(vm.sshHint, "ssh -p 2224 user@localhost");
});

Deno.test("hangar start.sh: a binary in a variable, a quoted name, cdroms skipped", () => {
  const vm = parseStartScript("windows-x64", `${ROOT}/windows-x64`, WINDOWS_SCRIPT);
  assertEquals(vm.name, "Windows 11 x64");
  assertEquals(vm.arch, "x86_64");
  assertEquals(vm.accel, "tcg");
  assertEquals(vm.cpus, 6);
  assertEquals(vm.memoryMiB, 8192);
  assertEquals(vm.disks, ["disk.qcow2"]);
  assertEquals(vm.pidFile, null);
  assertEquals(vm.headlessCapable, false);
  assertEquals(vm.forwards.map((f) => [f.hostPort, f.guestPort]), [[3390, 3389], [2227, 22]]);
  assertEquals(vm.sshHint, null);
});

Deno.test("hangar start.sh: variables and memory sizes", () => {
  assertEquals(
    expandScriptVariables('X=1\n-m ${MEM:-6G} ${X} $X "$X" ${Y}'),
    'X=1\n-m 6G 1 1 "1" ${Y}',
  );
  assertEquals(parseMemoryMiB("6G"), 6144);
  assertEquals(parseMemoryMiB("512M"), 512);
  assertEquals(parseMemoryMiB("2048"), 2048);
  assertEquals(parseMemoryMiB("lots"), null);
});

Deno.test("hangar start.sh: an ssh hint with shell syntax is not taken", () => {
  const vm = parseStartScript(
    "x",
    "/x",
    "# SSH: ssh -p 1 u@localhost; rm -rf ~\nqemu-system-aarch64",
  );
  assertEquals(vm.sshHint, null);
});

// --- Hangar VM config ------------------------------------------------------------------------

Deno.test("hangar config: a valid config round-trips", () => {
  assertEquals(parseVmConfig(JSON.parse(JSON.stringify(CONFIG))), CONFIG);
});

Deno.test("hangar config: bad values are refused, naming the field", () => {
  const bad = (patch: Record<string, unknown>, text: string) => {
    const err = assertThrows(() => parseVmConfig({ ...CONFIG, ...patch }), ConfigError);
    assertStringIncludes(err.message, text);
  };
  bad({ arch: "x86_64" }, "hvf"); // hvf runs aarch64 guests only
  bad({ cpus: 0 }, "cpus");
  bad({ memoryMiB: 100 }, "memoryMiB");
  bad({ disks: [] }, "at least one");
  bad({ disks: [{ file: "../escape.qcow2" }] }, "disks[0].file");
  bad({ iso: "relative.iso" }, "iso");
  bad({ iso: "/a,b.iso" }, "iso"); // a comma would inject a -drive option
  bad({ name: 'x",y' }, "name");
  bad({
    nics: [{
      forwards: [{ hostPort: 2300, guestPort: 22 }, { hostPort: 2300, guestPort: 80 }],
    }],
  }, "twice");
});

Deno.test("hangar config: the QEMU command line, headless and windowed", () => {
  const headless = buildQemuCommand(CONFIG, { headless: true, qemuPrefix: "/opt/homebrew" });
  assertEquals(headless.program, QEMU_A64);
  const a = headless.args.join(" ");
  assertStringIncludes(a, "-name Test VM -M virt,highmem=on -accel hvf -cpu host");
  assertStringIncludes(a, "-smp 2 -m 2048M");
  assertStringIncludes(a, "-drive file=disk.qcow2,if=virtio,format=qcow2");
  assertStringIncludes(a, "-nic user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:2300-:22");
  assertStringIncludes(a, "-qmp unix:qmp.sock,server=on,wait=off");
  assertStringIncludes(a, "-display none -daemonize -pidfile qemu.pid");
  const windowed = buildQemuCommand(
    { ...CONFIG, arch: "x86_64", accel: "tcg", iso: "/isos/install.iso", nics: [] },
    { headless: false, qemuPrefix: "/usr" },
  );
  assertEquals(windowed.program, "/usr/bin/qemu-system-x86_64");
  const w = windowed.args.join(" ");
  assertStringIncludes(w, "-M q35 -accel tcg,thread=multi");
  assertStringIncludes(w, "-drive file=/isos/install.iso,media=cdrom,readonly=on -boot once=d");
  assertStringIncludes(w, "-nic none");
  assertStringIncludes(w, "-display cocoa");
  assert(!w.includes("daemonize"));
});

// --- processes -------------------------------------------------------------------------------

Deno.test("hangar processes: ps output, and only qemu-system binaries count", () => {
  const procs = parsePs(
    "  101     1 2048000  45.5 /opt/homebrew/bin/qemu-system-aarch64 -name linux-arm -m 6G\n" +
      "  102     1    1000   0,1 /bin/bash -c echo qemu-system-aarch64\n" +
      "garbage\n",
  );
  assertEquals(procs.length, 2);
  assertEquals(procs[0].rssKiB, 2048000);
  assertEquals(procs[1].cpuPercent, 0.1);
  assertEquals(procs.map(isQemuSystem), [true, false]);
  assertEquals(parsePidFile(" 4242\n"), 4242);
  assertEquals(parsePidFile("1"), null);
  assertEquals(parsePidFile("12 34"), null);
});

Deno.test("hangar processes: matched by working directory, never by -name", async () => {
  const host = library()
    .proc(101, `${ROOT}/linux-arm`, `${QEMU_A64} -name linux-arm`)
    // Claims the name, runs elsewhere: not the library VM's.
    .proc(102, "/tmp/other", `${QEMU_A64} -name windows-x64`);
  const vms = await scanLibrary(host, ROOT);
  const matches = await matchInstances(host, vms);
  assertEquals(matches.get("linux-arm")?.instance?.pid, 101);
  assertEquals(matches.get("linux-arm")?.instance?.matchedBy, "cwd");
  assertEquals(matches.get("windows-x64")?.instance, null);
});

Deno.test("hangar processes: the pidfile only for a process whose cwd is unknown", async () => {
  const host = library().file(`${ROOT}/linux-arm/qemu.pid`, "103\n");
  const vms = await scanLibrary(host, ROOT);
  host.proc(103, "/elsewhere", `${QEMU_A64}`);
  assertEquals((await matchInstances(host, vms)).get("linux-arm")?.instance, null);
  host.processList[0].cwd = null;
  const m = (await matchInstances(host, vms)).get("linux-arm");
  assertEquals(m?.instance?.matchedBy, "pidfile");
});

Deno.test("hangar processes: two processes in one folder are ambiguous", async () => {
  const host = library()
    .proc(101, `${ROOT}/linux-arm`, QEMU_A64)
    .proc(102, `${ROOT}/linux-arm/`, QEMU_A64);
  const m = (await matchInstances(host, await scanLibrary(host, ROOT))).get("linux-arm");
  assert(m?.ambiguous);
});

// --- library ---------------------------------------------------------------------------------

Deno.test("hangar library: adopts start.sh folders and Hangar configs, reads nothing else", async () => {
  const host = library();
  const vms = await scanLibrary(host, ROOT);
  assertEquals(vms.map((v) => [v.id, v.kind]), [
    ["linux-arm", "script"],
    ["mine", "hangar"],
    ["windows-x64", "script"],
  ]);
  assertEquals(host.reads.filter((r) => !/\/(start\.sh|hangar\.json)$/.test(r)), []);
  await assertRejects(
    () => readVmFile(host, `${ROOT}/linux-arm`, "credentials.txt"),
    HangarError,
    "does not read",
  );
  // Images list names and sizes only.
  const images = await hangarOn(host).images("linux-arm");
  assertEquals(images.map((i) => i.file), ["disk.qcow2"]);
  assert(!host.reads.some((r) => r.endsWith("credentials.txt")));
});

Deno.test("hangar library: a missing root is an empty library", async () => {
  assertEquals(await scanLibrary(new FakeHost(), "/nowhere"), []);
});

// --- instances -------------------------------------------------------------------------------

Deno.test("hangar start: a script VM headless runs start.sh with LAB_HEADLESS=1 in its folder", async () => {
  const host = library();
  const h = hangarOn(host);
  assertEquals(await h.start("linux-arm", { headless: true, allowOverBudget: false }), {
    started: true,
  });
  assertEquals(host.spawns, [{
    program: "/bin/bash",
    args: ["start.sh"],
    cwd: `${ROOT}/linux-arm`,
    env: { LAB_HEADLESS: "1" },
  }]);
  await assertRejects(
    () => h.start("windows-x64", { headless: true, allowOverBudget: false }),
    HangarError,
    "no headless mode",
  );
  await assertRejects(
    () => h.start("../etc", { headless: false, allowOverBudget: false }),
    HangarError,
    "No such VM",
  );
});

Deno.test("hangar start: a Hangar VM runs QEMU directly; a running VM is refused", async () => {
  const host = library();
  const h = hangarOn(host);
  await h.start("mine", { headless: false, allowOverBudget: false });
  assertEquals(host.spawns[0].program, QEMU_A64);
  assertEquals(host.spawns[0].cwd, `${ROOT}/mine`);
  assert(host.spawns[0].args.includes("cocoa"));
  host.proc(201, `${ROOT}/mine`, QEMU_A64);
  await assertRejects(
    () => h.start("mine", { headless: false, allowOverBudget: false }),
    HangarError,
    "already running",
  );
});

Deno.test("hangar start: over the RAM budget asks first", async () => {
  const host = library().proc(101, `${ROOT}/linux-arm`, QEMU_A64, 20 * 1024 * 1024);
  host.memory = 32 * 1024 ** 3; // budget 75% = 24 GiB; 20 GiB used + 8 GiB asked
  const h = hangarOn(host);
  const r = await h.start("windows-x64", { headless: false, allowOverBudget: false });
  assertEquals(r.started, false);
  assert(!r.started && r.overByBytes === 4 * 1024 ** 3);
  assertEquals(host.spawns.length, 0);
  assertEquals(
    await h.start("windows-x64", { headless: false, allowOverBudget: true }),
    { started: true },
  );
});

Deno.test("hangar overview: instances, budget and the tooltip", async () => {
  const host = library().proc(101, `${ROOT}/linux-arm`, QEMU_A64, 2 * 1024 * 1024);
  const o = await hangarOn(host).overview();
  assertEquals(o.vms.find((r) => r.vm.id === "linux-arm")?.instance?.rssBytes, 2 * 1024 ** 3);
  assertEquals(o.budget.level, "ok");
  assertEquals(o.tooltip, "Hangar: 1 VM running, 2.0 GiB RAM");
});

Deno.test("hangar shutdown: system_powerdown, then the VM is gone", async () => {
  const host = library().proc(101, `${ROOT}/linux-arm`, QEMU_A64);
  const commands: string[] = [];
  host.qmpSockets.set(`${ROOT}/linux-arm/qmp.sock`, (cmd) => {
    commands.push(cmd);
    if (cmd === "system_powerdown") host.processList = [];
    return {};
  });
  assertEquals(await hangarOn(host).shutdown("linux-arm"), "powered-off");
  assertEquals(commands, ["system_powerdown"]);
  assertEquals(host.kills, []);
  assertEquals(await hangarOn(host).shutdown("linux-arm"), "not-running");
});

Deno.test("hangar shutdown: a guest that ignores the button gets QMP quit after the timeout", async () => {
  const host = library().proc(101, `${ROOT}/linux-arm`, QEMU_A64);
  const commands: string[] = [];
  host.qmpSockets.set(`${ROOT}/linux-arm/qmp.sock`, (cmd) => {
    commands.push(cmd);
    if (cmd === "quit") host.processList = [];
    return {};
  });
  const h = createHangar(host, {
    ...defaultSettings(host.home, host.os),
    shutdownTimeoutSeconds: 5,
  });
  assertEquals(await h.shutdown("linux-arm"), "quit");
  assertEquals(commands, ["system_powerdown", "quit"]);
  assert(host.slept >= 5000);
  assertEquals(host.kills, []);
});

Deno.test("hangar shutdown: no QMP socket is an error, not a kill", async () => {
  const host = library().proc(101, `${ROOT}/linux-arm`, QEMU_A64);
  await assertRejects(() => hangarOn(host).shutdown("linux-arm"), Error, "refused");
  assertEquals(host.kills, []);
});

Deno.test("hangar status: QMP query-status, stopped, or unknown", async () => {
  const host = library().proc(101, `${ROOT}/linux-arm`, QEMU_A64);
  const h = hangarOn(host);
  assertEquals(await h.status("linux-arm"), "unknown"); // no socket
  host.qmpSockets.set(`${ROOT}/linux-arm/qmp.sock`, () => ({ status: "running", running: true }));
  assertEquals(await h.status("linux-arm"), "running");
  assertEquals(await h.status("windows-x64"), "stopped");
});

Deno.test("hangar force stop: the confirm, the exact pid, then SIGTERM", async () => {
  const host = library().proc(101, `${ROOT}/linux-arm`, QEMU_A64);
  const h = hangarOn(host);
  await assertRejects(() => h.forceStop("linux-arm", 101, "yes"), HangarError, "to confirm");
  await assertRejects(
    () => h.forceStop("linux-arm", 999, "linux-arm"),
    HangarError,
    "not running as",
  );
  assertEquals(host.kills, []);
  await h.forceStop("linux-arm", 101, "linux-arm");
  assertEquals(host.kills, [{ pid: 101, signal: "SIGTERM" }]);
});

Deno.test("hangar force stop: SIGKILL when SIGTERM is not enough; never another VM's process", async () => {
  const host = library()
    .proc(101, `${ROOT}/linux-arm`, QEMU_A64)
    .proc(300, "/somewhere/else", QEMU_A64);
  host.termKills = false;
  const h = hangarOn(host);
  await h.forceStop("linux-arm", 101, "linux-arm");
  assertEquals(host.kills, [{ pid: 101, signal: "SIGTERM" }, { pid: 101, signal: "SIGKILL" }]);
  // A QEMU outside the library: no VM id names it, so it can never be stopped.
  await assertRejects(() => h.forceStop("linux-arm", 300, "linux-arm"), HangarError);
  assert(host.processList.some((p) => p.pid === 300));
});

// --- images ----------------------------------------------------------------------------------

/** A host whose qemu-img answers `info` with {@link INFO_JSON}. */
function withQemuImg(host: FakeHost): FakeHost {
  host.onRun = (_program, args) => ({
    code: 0,
    stdout: args[0] === "info" ? INFO_JSON : "",
    stderr: "",
  });
  return host;
}

Deno.test("hangar images: info, with the backing file's name only", async () => {
  const host = withQemuImg(library());
  const info = await hangarOn(host).imageInfo("linux-arm", "disk.qcow2");
  assertEquals(info.virtualBytes, 10 * 1024 ** 3);
  assertEquals(info.backingFile, "base.qcow2");
  assertEquals(info.snapshots, [{ id: "1", name: "clean", date: 1700000000, vmStateBytes: 0 }]);
  assertEquals(host.runs[0], {
    program: "/opt/homebrew/bin/qemu-img",
    args: ["info", "--force-share", "--output=json", `${ROOT}/linux-arm/disk.qcow2`],
  });
});

Deno.test("hangar images: names outside the folder, symlinks out and existing targets are refused", async () => {
  const host = withQemuImg(library());
  host.links.set(`${ROOT}/linux-arm/evil.qcow2`, "/etc/passwd");
  host.file("/etc/passwd", "x");
  const h = hangarOn(host);
  await assertRejects(
    () => h.imageInfo("linux-arm", "../windows-x64/disk.qcow2"),
    HangarError,
    "Not an image",
  );
  await assertRejects(
    () => h.imageInfo("linux-arm", "credentials.txt"),
    HangarError,
    "Not an image",
  );
  await assertRejects(() => h.imageInfo("linux-arm", "evil.qcow2"), HangarError, "outside");
  await assertRejects(
    () => h.createImage("linux-arm", "disk.qcow2", "10G", "qcow2"),
    HangarError,
    "already exists",
  );
  assertEquals(host.runs, []);
});

Deno.test("hangar images: create, grow-only resize, convert", async () => {
  const host = withQemuImg(library());
  const h = hangarOn(host);
  await h.createImage("linux-arm", "data.qcow2", "20G", "qcow2");
  assertEquals(host.runs.at(-1)?.args, [
    "create",
    "-f",
    "qcow2",
    `${ROOT}/linux-arm/data.qcow2`,
    "20G",
  ]);
  await assertRejects(
    () => h.resizeImage("linux-arm", "disk.qcow2", "5G"),
    HangarError,
    "only grows",
  );
  await h.resizeImage("linux-arm", "disk.qcow2", "20G");
  assertEquals(host.runs.at(-1)?.args, [
    "resize",
    "-f",
    "qcow2",
    `${ROOT}/linux-arm/disk.qcow2`,
    "20G",
  ]);
  await h.convertImage("linux-arm", "disk.qcow2", "disk.raw", "raw");
  assertEquals(host.runs.at(-1)?.args, [
    "convert",
    "-O",
    "raw",
    `${ROOT}/linux-arm/disk.qcow2`,
    `${ROOT}/linux-arm/disk.raw`,
  ]);
  await assertRejects(
    () => h.createImage("linux-arm", "x.qcow2", "big", "qcow2"),
    HangarError,
    "Size",
  );
  await assertRejects(
    () => h.createImage("linux-arm", "x.qcow2", "1G", "vmdk" as "raw"),
    HangarError,
    "Format",
  );
});

Deno.test("hangar images: qemu-img errors reach the page without the folder path", async () => {
  const host = library();
  host.onRun = () => ({
    code: 1,
    stdout: "",
    stderr: `qemu-img: ${ROOT}/linux-arm/disk.qcow2: bad\n`,
  });
  const err = await assertRejects(
    () => hangarOn(host).imageInfo("linux-arm", "disk.qcow2"),
    HangarError,
  );
  assertEquals(err.message, "qemu-img info failed: qemu-img: linux-arm/disk.qcow2: bad");
});

Deno.test("hangar snapshots: apply and delete need the confirm; nothing while running", async () => {
  const host = withQemuImg(library());
  const h = hangarOn(host);
  await h.snapshot("linux-arm", "disk.qcow2", "create", "before-upgrade");
  assertEquals(host.runs.at(-1)?.args, [
    "snapshot",
    "-c",
    "before-upgrade",
    `${ROOT}/linux-arm/disk.qcow2`,
  ]);
  await assertRejects(
    () => h.snapshot("linux-arm", "disk.qcow2", "apply", "clean"),
    HangarError,
    "confirm",
  );
  await h.snapshot("linux-arm", "disk.qcow2", "apply", "clean", "clean");
  assertEquals(host.runs.at(-1)?.args.slice(0, 3), ["snapshot", "-a", "clean"]);
  await h.snapshot("linux-arm", "disk.qcow2", "delete", "clean", "clean");
  assertEquals(host.runs.at(-1)?.args.slice(0, 3), ["snapshot", "-d", "clean"]);
  await assertRejects(
    () => h.snapshot("linux-arm", "disk.qcow2", "create", "a b"),
    HangarError,
    "names",
  );
  host.proc(101, `${ROOT}/linux-arm`, QEMU_A64);
  const before = host.runs.length;
  await assertRejects(
    () => h.snapshot("linux-arm", "disk.qcow2", "create", "x"),
    HangarError,
    "running",
  );
  assertEquals(host.runs.length, before);
});

Deno.test("hangar images: delete needs the file's name typed and a stopped VM", async () => {
  const host = library();
  const h = hangarOn(host);
  await assertRejects(
    () => h.deleteImage("windows-x64", "windows.iso", "yes"),
    HangarError,
    "confirm",
  );
  await h.deleteImage("windows-x64", "windows.iso", "windows.iso");
  assert(!host.files.has(`${ROOT}/windows-x64/windows.iso`));
  host.proc(101, `${ROOT}/linux-arm`, QEMU_A64);
  await assertRejects(
    () => h.deleteImage("linux-arm", "disk.qcow2", "disk.qcow2"),
    HangarError,
    "running",
  );
  assert(host.files.has(`${ROOT}/linux-arm/disk.qcow2`));
});

// --- creating a VM ---------------------------------------------------------------------------

Deno.test("hangar create VM: a folder with its disk, UEFI vars and hangar.json", async () => {
  const host = library().file("/isos/install.iso", "x");
  const h = hangarOn(host);
  const vm = await h.createVm("new-vm", { ...CONFIG, iso: "/isos/install.iso", nics: [] }, "40G");
  assertEquals(vm.kind, "hangar");
  assertEquals(host.runs[0].args, ["create", "-f", "qcow2", `${ROOT}/new-vm/disk.qcow2`, "40G"]);
  assertStringIncludes(host.files.get(`${ROOT}/new-vm/vars.fd`)!, "edk2-arm-vars.fd");
  assertEquals(JSON.parse(host.files.get(`${ROOT}/new-vm/hangar.json`)!).iso, "/isos/install.iso");
});

Deno.test("hangar create VM: a bad id, an existing folder, a taken port, a missing ISO", async () => {
  const host = library();
  const h = hangarOn(host);
  await assertRejects(() => h.createVm("../x", CONFIG, "10G"), HangarError, "id");
  await assertRejects(() => h.createVm("linux-arm", CONFIG, "10G"), HangarError, "exists");
  const clash = {
    ...CONFIG,
    nics: [{ forwards: [{ hostPort: 2224, guestPort: 22 }] }],
  };
  await assertRejects(() => h.createVm("other", clash, "10G"), HangarError, "2224");
  await assertRejects(
    () => h.createVm("other", { ...CONFIG, iso: "/missing.iso" }, "10G"),
    HangarError,
    "ISO",
  );
  await assertRejects(
    () => h.createVm("other", { ...CONFIG, cpus: 999 }, "10G"),
    HangarError,
    "cpus",
  );
  assertEquals(host.runs, []);
});

Deno.test("hangar terminal: osascript with the generated ssh command, macOS only", async () => {
  const host = library();
  await hangarOn(host).openTerminal("linux-arm");
  assertEquals(host.runs[0].program, "/usr/bin/osascript");
  assertStringIncludes(host.runs[0].args[1], 'do script "ssh -p 2224 user@localhost"');
  host.os = "linux";
  await assertRejects(() => hangarOn(host).openTerminal("linux-arm"), HangarError, "Copy");
});

// --- settings, formatting, tray --------------------------------------------------------------

Deno.test("hangar settings: defaults and validation", () => {
  const base = defaultSettings("/home/u", "darwin");
  assertEquals(base.libraryRoot, "/home/u/VMs");
  assertEquals(base.qemuPrefix, "/opt/homebrew");
  assertEquals(
    parseSettings({ ramBudgetPercent: 50, libraryRoot: "/vms/" }, base).libraryRoot,
    "/vms",
  );
  assertThrows(() => parseSettings({ ramBudgetPercent: 5 }, base), HangarError);
  assertThrows(() => parseSettings({ libraryRoot: "relative" }, base), HangarError);
  assertThrows(() => parseSettings({ libraryRoot: "/a/../b" }, base), HangarError);
});

Deno.test("hangar format: sizes, budget, tooltip, quick actions", () => {
  assertEquals(formatBytes(1536), "1.5 KiB");
  assertEquals(formatBytes(12), "12 B");
  assertEquals(parseSize(" 20gb "), "20G");
  assertEquals(parseSize("0G"), null);
  assertEquals(sizeBytes("2G"), 2 * 1024 ** 3);
  const b = ramBudget(9 * 1024 ** 3, 16 * 1024 ** 3, 50);
  assertEquals(b.level, "over");
  assertEquals(ramBudget(7 * 1024 ** 3, 16 * 1024 ** 3, 50).level, "warn");
  assertEquals(overBudgetBy(ramBudget(0, 16 * 1024 ** 3, 50), 1024), 0);
  assertEquals(trayTooltip([], b), "Hangar: no VMs running");
  const win = parseStartScript("w", "/w", WINDOWS_SCRIPT);
  assertEquals(sshCommand(win), "ssh -p 2227 localhost");
  assertEquals(rdpAddress(win), "localhost:3390");
  assertEquals(rdpAddress({ ...win, forwards: [] } as VmDefinition), null);
});

Deno.test("hangar tray: the menu lists running VMs, startable ones and the windows", async () => {
  const host = library().proc(101, `${ROOT}/linux-arm`, QEMU_A64);
  const overview: Overview = await hangarOn(host).overview();
  const menu = trayMenu(overview);
  const labels = JSON.stringify(menu);
  assertStringIncludes(labels, `${SHUTDOWN_PREFIX}linux-arm`);
  assertStringIncludes(labels, "start:mine"); // headless-capable and stopped
  assert(!labels.includes("start:windows-x64")); // no headless mode
  assertStringIncludes(labels, MENU.settings);
  assertEquals(menu.at(-1), { role: "quit" });
  assertStringIncludes(JSON.stringify(trayMenu(null)), "No VMs running");
});

// --- QMP -------------------------------------------------------------------------------------

/** A fake QEMU on the other end of an in-memory socket: answers each command with `reply`. */
function fakeQmpSocket(reply: (msg: Record<string, unknown>) => string[], greeting = '{"QMP":{}}') {
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const fromClient = new TransformStream<Uint8Array, Uint8Array>();
  const writer = toClient.writable.getWriter();
  const enc = new TextEncoder();
  const received: Record<string, unknown>[] = [];
  void writer.write(enc.encode(greeting + "\r\n"));
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of fromClient.readable) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        received.push(msg);
        for (const line of reply(msg)) await writer.write(enc.encode(line + "\r\n"));
      }
    }
  })().catch(() => {});
  let closed = false;
  return {
    received,
    get closed() {
      return closed;
    },
    stream: {
      readable: toClient.readable,
      writable: fromClient.writable,
      close() {
        closed = true;
        void writer.close().catch(() => {});
      },
    },
  };
}

Deno.test("hangar qmp: handshake, events skipped, returns and errors by id", async () => {
  const sock = fakeQmpSocket((msg) => {
    if (msg.execute === "qmp_capabilities") return ['{"return": {}}'];
    if (msg.execute === "query-status") {
      return [
        '{"event": "RESUME", "timestamp": {}}',
        `{"return": {"status": "running"}, "id": ${msg.id}}`,
      ];
    }
    return [`{"error": {"class": "CommandNotFound", "desc": "nope"}, "id": ${msg.id}}`];
  });
  const session = await openQmpSession(sock.stream, 1000);
  assertEquals(await session.execute("query-status"), { status: "running" });
  const err = await assertRejects(() => session.execute("bogus"), QmpError, "nope");
  assertEquals(err.errorClass, "CommandNotFound");
  assertEquals(sock.received.map((m) => m.execute), ["qmp_capabilities", "query-status", "bogus"]);
  session.close();
  assert(sock.closed);
});

Deno.test("hangar qmp: a socket that is not QMP is refused and closed", async () => {
  const sock = fakeQmpSocket(() => [], '{"hello": 1}');
  await assertRejects(() => openQmpSession(sock.stream, 1000), Error, "no greeting");
  assert(sock.closed);
});

Deno.test("hangar images: parse qemu-img info with no snapshots", () => {
  const info = parseImageInfo("d.raw", '{"format":"raw","virtual-size":1024}');
  assertEquals(info, {
    file: "d.raw",
    format: "raw",
    virtualBytes: 1024,
    actualBytes: 0,
    backingFile: null,
    snapshots: [],
  });
});

// --- the window side -------------------------------------------------------------------------

Deno.test("hangar: the entry, the extension and the pages type-check against denext", async () => {
  const dir = fromFileUrl(new URL("../examples/hangar/", import.meta.url));
  const files = [
    "desktop.ts",
    "desktop/hangar.ts",
    "lib/deno-host.ts",
    "app/layout.tsx",
    "app/page.tsx",
    "app/vm/page.tsx",
    "app/images/page.tsx",
    "app/create/page.tsx",
    "app/settings/page.tsx",
  ];
  // `--no-lock`: checking never rewrites the example's committed lock file.
  const out = await boundedDeno(["check", "--no-lock", "--config", "deno.json", ...files], {
    cwd: dir,
  });
  assertEquals(out.code, 0, out.stderr);
});
