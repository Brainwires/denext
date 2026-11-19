---
title: Kernel sandbox warn mode
slug: kernel-sandbox-warn
lead: Warn mode runs your program exactly as before and tells you what the kernel sandbox would refuse under enforce — each access, who made it, and the grant that would allow it. Nothing is refused. It is how you find the grants an app needs before you turn enforcement on.
---

> [!IMPORTANT]
> **This page describes warn mode as it works in the runtime line after the one denext 4.20 pins.**
> On the runtime denext 4.20 pins, `--kernel-sandbox=warn` prints one line (how many rules only
> Deno's checks would hold) and nothing else. A runtime has the warn mode described here when
> `deno info --json` reports a `kernelSandbox.stage` field. `denext kernel-sandbox check` works on
> both and says which it found.

## What warn mode is for

`--kernel-sandbox=enforce` holds a program's native code and child processes to the same grant as
its JavaScript. Most programs already stay inside their grant. The ones that don't usually fail in
one of three ways: a child process reads a file nobody granted (`git` and `~/.gitconfig`), native
code opens a socket or loads a library from an unexpected place, or a program can't work inside
any sandbox (a browser's own sandbox, `sudo`).

Warn mode finds those before they fail. It computes the same policy `enforce` would apply, watches
the run where the operating system lets it, and reports each access that policy would refuse:

```sh
deno run --kernel-sandbox=warn --allow-run --allow-env=HOME --allow-read=. build.ts
```

```text
Warning kernel sandbox (warn, preview): nothing is refused; 0 rule(s) would be held by Deno's checks only. Run with --kernel-sandbox-report for the policy.
Warning kernel sandbox (warn): git inside the sandbox: it reads its configuration (grant --allow-read=<home>/.gitconfig) and, for SSH remotes, the agent socket (--allow-net=unix:$SSH_AUTH_SOCK)
Warning kernel sandbox (warn): enforce would refuse reading /Users/me/.gitconfig (git, pid 4312). Grant: --allow-read=/Users/me/.gitconfig
Warning kernel sandbox (warn): enforce would refuse writing /private/tmp/build-cache/index (sh, pid 4320). Grant: --allow-write=/private/tmp/build-cache/index
Warning kernel sandbox (warn): enforce would refuse connecting to *:443 (curl, pid 4331). Grant: --allow-net=<host>:443
Warning kernel sandbox (warn): enforce would refuse 3 access(es). Grants that would allow them: --allow-net=<host>:443 --allow-read=/Users/me/.gitconfig --allow-write=/private/tmp/build-cache/index
```

The first line is the mode's own. The `git inside the sandbox` line is an advisory, printed when
the program starts `git`. The three `enforce would refuse` lines are the kernel's reports of what
`git`, a shell and `curl` did outside the grant. The last line is the summary.

The program ran to the end, with the same result as without the flag.

## What a line tells you

```text
Warning kernel sandbox (warn): enforce would refuse reading /Users/me/.gitconfig (git, pid 4312). Grant: --allow-read=/Users/me/.gitconfig
```

- **The access:** what would be refused (reading, writing, starting a program, loading native
  code, connecting, listening, a Unix socket, system information, an OS service) and its target.
- **Who made it:** the program's name and process id, when the report came from the kernel. `deno`
  is your program itself or native code loaded into it; any other name is a child process.
- **The grant:** the permission to add so `enforce` allows it. A line that ends with a sentence
  instead of `Grant:` is something no permission allows; the sentence says why.

Each distinct access prints once, however often it happens, and the first 20 print; the rest are
counted in the last line and written to the [log file](#the-log-file).

### Grants and cautions

| The report                            | The grant it names                    | Notes                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| reading a path                        | `--allow-read=<path>`                 | Grant the folder instead when a program reads many files in it.                                                                                                                                                    |
| writing, creating, removing a path    | `--allow-write=<path>`                |                                                                                                                                                                                                                    |
| loading native code from a path       | `--allow-ffi=<path>`                  | The library's folder also has to be readable.                                                                                                                                                                      |
| starting a program                    | `--allow-run=<program>`               | Only with [`--kernel-sandbox-exec=strict`](/docs/kernel-sandbox#subprocesses-inherit-the-sandbox) or with no `--allow-run` at all.                                                                                 |
| connecting to `*:<port>`              | `--allow-net=<host>:<port>`           | The kernel reports the port, never the name. Replace `<host>` with the host the program connects to.                                                                                                               |
| listening on a port                   | `--allow-net=0.0.0.0:<port>`          | Use the address the program binds.                                                                                                                                                                                 |
| a Unix socket                         | `--allow-net=unix:<path>`             | A container daemon's socket is usually root on the host.                                                                                                                                                           |
| system information                    | `--allow-sys=<name>`                  | Where the kernel narrows it (load average, memory size on macOS).                                                                                                                                                  |
| a path that usually holds credentials | the grant, with a caution in brackets | `~/.ssh`, `~/.aws`, `~/.npmrc`, `~/.netrc`, `~/.config/gh` and similar. Grant one only if you accept that native code and child processes can read it.                                                             |
| an OS service, another terminal, ...  | none                                  | Refused whatever is granted: a macOS service the profile doesn't list, a terminal that isn't the run's own, a terminal `ioctl`. The program has to do without it under `enforce`, or that command stays on `warn`. |

A suggestion is the narrowest grant that would have allowed that one access. It is yours to widen
(a folder for a file) or to refuse (change the program so it doesn't need it).

## Where reports come from

Four sources feed one reporter. Each line of the [log file](#the-log-file) says which one it is.

| Source     | When                        | What it reports                                                                                                                                                                        |
| ---------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy`   | at startup                  | A rule this machine's kernel can't hold, over which `enforce` would **refuse to start** (a host-scoped `--allow-net` on Linux without the supervisor, a port list on an older kernel). |
| `advisory` | when the program starts one | What is known about a program before it runs: `git`, `ssh`, `npm`, `docker` need a grant of their own; `sudo`, a browser's sandbox, `strace`, `bwrap` can't work inside a sandbox.     |
| `runtime`  | while the program runs      | A decision the runtime or its supervisor would have refused: a file or network request to the Mode B supervisor, a desktop host's request.                                             |
| `os`       | while the program runs      | The kernel's own record of an access by native code or a child process that the enforce policy refuses. **macOS only** today; see [what each platform sees](#what-each-platform-sees). |

A `policy` line looks like this, and means `enforce` wouldn't start at all with this grant here:

```text
Warning kernel sandbox (warn): enforce would refuse to start: --kernel-sandbox (broker). the supervising broker (Mode B) is not built into this runtime yet: host-scoped network would be held by Deno's checks only (needed for: --allow-net=example.com)
Warning kernel sandbox (warn): enforce would refuse to start over 1 rule(s) the OS can't hold here
```

## What each platform sees

Warn mode can only report what something observes. The policy and the runtime's own decisions are
seen everywhere. What native code and child processes do is seen only where the kernel can report
an access without refusing it.

| Platform | Policy at startup | Program advisories | Native code and child processes                                                                                             |
| -------- | ----------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| macOS    | yes               | yes                | **yes**: every access, with the program's name                                                                              |
| Linux    | yes               | yes                | **no**: Landlock has no report-only mode. They show under `enforce` only ([finding them on Linux](#finding-them-on-linux)). |
| Windows  | yes               | yes                | no: reads and the network are held by Deno's checks there, so there is little for the kernel to refuse                      |

### macOS: the reporting profile

On macOS a warn run applies a Seatbelt profile to itself, at the point where `enforce` would (the
module graph is loaded, no user code has run). The profile is the enforce profile for the same
grant with every refusal turned into "allow, and report": it **allows everything**, and each
access the enforce profile refuses is written to the system log, tagged with a tag unique to the
run. The run reads its own lines back while it runs and prints them.

Three things follow from that:

- **The reports are exact.** They come from the same rules, in the same order, as the enforce
  profile. An access that isn't reported would be allowed under `enforce`, and the other way round.
- **Reports arrive a moment after the access.** A line can print a second after the thing it
  describes. When the program ends, the run waits until its last lines are in (usually a fraction
  of a second, ten seconds at most) before it prints the summary. A program killed with a signal
  prints what had arrived by then.
- **A warn run starts a second or two slower.** The run starts the system's log stream before it
  applies the profile and waits for it to be ready. `enforce` has none of this cost.
- **The program's own system information isn't reported.** `sys` is held by Deno's checks for
  your JavaScript; the runtime itself reads the memory size at startup and does without it under
  `enforce`. A child process reading it is reported.
- **A program that applies a sandbox of its own fails**, as it would under `enforce`. macOS doesn't
  nest Seatbelt profiles, so a browser (Chrome under Puppeteer or Playwright), `sandbox-exec`, a
  nested `--kernel-sandbox=enforce`, or the `swift` toolchain refuses to start inside any profile,
  even one that allows everything. Start a browser with `--no-sandbox`, as in a container, or keep
  the observer off for that run:

  ```sh
  DENO_KERNEL_SANDBOX_WARN_OBSERVE=0 deno run --kernel-sandbox=warn …
  ```

  With the observer off, nothing at all is applied to the process, and the run reports from the
  policy and the advisories only.

Reading the system log needs an account that may read it (an administrator account can). Where it
can't be read, the run says so once and carries on without the observer.

The observer applies to `deno run` and `deno serve`. Under `deno test`, `deno bench`, the REPL and
in a compiled program, warn mode reports from the policy and the advisories.

### Finding them on Linux

Linux can't say what native code and child processes would be refused without refusing it. Two
ways to find out:

1. **Run it enforced where a failure is harmless.** A branch build, a staging host, a container.
   Under `--kernel-sandbox=enforce` a Deno operation the kernel refused fails with
   `(refused by the kernel sandbox; see --kernel-sandbox-report)`, and a child that exits non-zero
   prints a hint naming the sandbox. [Troubleshooting](/docs/kernel-sandbox-troubleshooting) maps
   symptoms to grants.
2. **Run the same program in warn mode on a Mac.** The grants a program's children need
   (`~/.gitconfig`, an agent socket, a cache folder) are mostly the same on both, with the paths of
   each platform.

On Linux 6.15 and later (Landlock ABI 7) the kernel also writes each refusal of an enforced run to
the audit log, where an administrator can read the path:
the records have the type `LANDLOCK_ACCESS` (`journalctl -k --grep LANDLOCK`, where the audit
messages reach the journal).

## The log file

Set `DENO_KERNEL_SANDBOX_WARN_LOG` to a file and every process of the run appends what it reports
to it, one JSON object per line. Tools read this instead of the terminal output;
[`denext kernel-sandbox check`](/docs/kernel-sandbox-migrating#2-find-what-would-be-refused) is one.

```sh
DENO_KERNEL_SANDBOX_WARN_LOG=./warn.jsonl deno run --kernel-sandbox=warn --allow-run main.ts
```

```json
{"type":"run","v":1,"pid":4301,"os":"macos","policy":"ad3da2d6ece47502","observer":"seatbelt-report","tag":"denext-ks:4301-73eca307","since":1795103295}
{"type":"wouldDeny","v":1,"class":"exec","target":"git","source":"advisory","note":"it reads its configuration (grant --allow-read=<home>/.gitconfig) and, for SSH remotes, the agent socket (--allow-net=unix:$SSH_AUTH_SOCK)"}
{"type":"wouldDeny","v":1,"class":"read","target":"/Users/me/.gitconfig","op":"file-read-data","source":"os","process":{"pid":4312,"name":"git"},"grant":{"flag":"--allow-read","value":"/Users/me/.gitconfig"}}
{"type":"wouldDeny","v":1,"class":"netConnect","target":"*:443","op":"network-outbound","source":"os","process":{"pid":4331,"name":"curl"},"grant":{"flag":"--allow-net","value":"<host>:443"}}
```

A `run` line opens each process's part:

| Field      | Meaning                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| `v`        | The format, `1`. Skip lines with another value.                                                            |
| `pid`      | The process.                                                                                               |
| `os`       | `linux`, `macos` or `windows`.                                                                             |
| `policy`   | The compiled policy's hash, as `--kernel-sandbox-report` prints it.                                        |
| `observer` | `seatbelt-report` (macOS's reporting profile), `supervisor-trace`, or `none`: nothing watched native code. |
| `tag`      | With `seatbelt-report`: the tag on the run's lines in the system log.                                      |
| `since`    | With an observer: when it was applied, in seconds since the Unix epoch.                                    |

A `wouldDeny` line is one access `enforce` would refuse:

| Field     | Meaning                                                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `class`   | `read`, `write`, `exec`, `loadCode`, `netConnect`, `netListen`, `unix`, `sys`, `env`, `signal`, `service`, `syscall`, `startup` (enforce wouldn't start) or `other`. |
| `target`  | What was accessed: a path, `host:port` (`*` for a host the kernel didn't report), a program, a service name, or for `startup` the rule as a flag.                    |
| `op`      | The operation as the reporter saw it (`file-read-data`, `network-outbound`), when it adds something.                                                                 |
| `source`  | `policy`, `advisory`, `runtime` or `os` ([where reports come from](#where-reports-come-from)).                                                                       |
| `process` | `{ "pid", "name" }` of the program that made the access, when the kernel reported it.                                                                                |
| `grant`   | `{ "flag", "value" }`: the permission that would allow it. Left out when no permission does.                                                                         |
| `note`    | Why no permission allows it, a caution about the grant, or for `startup` what the kernel would do instead.                                                           |

Each distinct access (the same class and target by the same program) is written once per process.
The file is only appended to, so remove it before a run you want to read alone.

To read the kernel's lines for a past run yourself on macOS, use the run's `tag`:

```sh
log show --last 1h --predicate 'sender == "Sandbox" AND eventMessage CONTAINS "denext-ks:4301-73eca307"'
```

## Turning warn mode on

| Where                                        | How                                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| One command                                  | `deno run --kernel-sandbox=warn …`                                                                    |
| Every `deno` a command starts                | `DENO_KERNEL_SANDBOX=warn <command>` (it never raises a mode; a `--kernel-sandbox` flag wins over it) |
| The whole project                            | `"permissions": { "kernelSandbox": "warn" }` in `deno.json`                                           |
| A compiled program                           | `deno compile --kernel-sandbox=warn …` (policy and advisories only)                                   |
| The app's `start` task, with a sorted report | [`denext kernel-sandbox check`](/docs/kernel-sandbox-migrating#2-find-what-would-be-refused)          |

`warn` applies to a run whose permissions aren't fixed too (`--watch`, `denext dev`), where
`enforce` refuses to start. A run with `-A` and no `--deny-*` has nothing for the kernel to hold,
so warn mode is off for it and prints nothing.

### The environment variables

| Variable                           | Meaning                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `DENO_KERNEL_SANDBOX=warn`         | Warn mode for every `deno run`-family process that reads it. Read before any `--env-file`; ignored by compiled programs. |
| `DENO_KERNEL_SANDBOX_WARN_LOG`     | The file to append the [JSON lines](#the-log-file) to.                                                                   |
| `DENO_KERNEL_SANDBOX_WARN_OBSERVE` | `0` keeps the observer off: nothing is applied to the process, and only the policy and the advisories report.            |

## The warning `auto` prints for a run with no terminal

Separate from the `warn` you ask for: once `auto` reaches the stage where it
[warns for a bare run with no terminal](/docs/kernel-sandbox-rollout#the-defaults), such a run
prints one notice, and only when enforcement could change something for it (it grants
`--allow-run` or `--allow-ffi`, or has a rule the kernel can't hold):

```text
Warning kernel sandbox: this run has no terminal, so its permissions are fixed, and a later release holds them with the kernel: the programs it starts and the native code it loads will get the same file and network grants as the program. Nothing is refused now. See what would be with --kernel-sandbox=warn, choose a mode in deno.json ("permissions": { "kernelSandbox": … }), or set DENO_KERNEL_SANDBOX=off.
```

That automatic warn applies **nothing** to the process (no reporting profile, no observer): a
default must not be able to break a program. It reports the policy's startup refusals and the
program advisories, prints once per policy on a machine (a marker in `DENO_DIR`), and says
nothing at all for a run whose grant has no native code or child processes in it. To see what
native code and children would be refused, ask for `--kernel-sandbox=warn` by name.

## Limits

- **Warn mode shows the run you ran.** A code path the run didn't take reported nothing. Exercise
  the app (its tests, the pages that shell out, the upload path) while it is in warn mode.
- **Linux and Windows don't see native code and child processes** ([above](#what-each-platform-sees)).
- **What `enforce` does before it confines isn't reproduced.** An enforced run fetches its static
  module graph first and keeps its caches in a [policy-keyed overlay](/docs/kernel-sandbox#what-enforce-does-today);
  a warn run uses the shared caches as usual, and the reporting profile keeps those quiet. A
  dynamic `import()` of a module that wasn't cached is reported as a connection, which is how it
  fails under `enforce`.
- **The environment isn't checked.** On Linux, `enforce` scrubs the environment to the
  `--allow-env` names; warn mode doesn't, and can't see which variables a child reads. See
  [a child is missing environment variables](/docs/kernel-sandbox-troubleshooting#a-child-is-missing-environment-variables-linux).
- **Nothing leaves the machine.** The reports go to stderr, to the file you name, and on macOS
  through the local system log. There is no telemetry.
