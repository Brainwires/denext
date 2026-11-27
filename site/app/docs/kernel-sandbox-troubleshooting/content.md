---
title: Kernel sandbox troubleshooting
slug: kernel-sandbox-troubleshooting
lead: Something that worked before fails under the kernel sandbox. How to tell whether the sandbox refused it, what the common symptoms mean, and the grant or setting that fixes each one.
---

> [!IMPORTANT]
> **An opt-in preview ships in denext 4.x; automatic enforcement lands in denext 5.0.** Today the
> kernel refuses things only in a `deno run`, `deno serve`, `deno test` or `deno bench` started
> with `--kernel-sandbox=enforce` or `broker` (or a `deno.json` that sets it) on Linux or macOS, and
> in a program compiled with it. This page
> collects symptoms as the sandbox is tested against real programs, packages and CI setups. The
> [overview](/docs/kernel-sandbox#what-enforce-does-today) has what `enforce` does today.

## Was it the kernel sandbox?

- **A Deno operation** the kernel refused fails with an error ending in
  `(refused by the kernel sandbox; see --kernel-sandbox-report)`. On Linux it's `EPERM`, or
  `EACCES` where the file's own mode would allow the access; on macOS it's `EPERM`.
- **A child process** that exits non-zero while the sandbox enforces prints one hint per run:
  `hint: a child process exited with code N while the kernel sandbox was enforcing; children inherit the file and network rules, so it may have been refused something (see --kernel-sandbox-report)`.
- **The report.** Run again with `--kernel-sandbox-report` added. It prints the policy (what may be
  read, written, executed, loaded, reached) and every gap before the program starts.
- **The quick test.** Run again with `DENO_KERNEL_SANDBOX=warn` (or `off`) when `enforce` comes
  from `deno.json`, or with `--kernel-sandbox=warn` in place of `--kernel-sandbox=enforce` (the
  variable doesn't lower the flag). If the failure goes away, the kernel refused it.

## Turning it down safely

In order of preference:

1. Grant what the program needs (`--allow-read=~/.gitconfig`, `--allow-env=CI`).
2. Use `--kernel-sandbox=warn` on that command while you work it out. `warn` is also safe as
   `"kernelSandbox": "warn"` in `deno.json`.
3. Use `DENO_KERNEL_SANDBOX=warn` or `off` for one CLI run (it can't raise the mode, and a `.env`
   file can't set it).

Reaching for `-A` is worse than any of them: it turns every Deno check off too.

## Refusals at startup

### `enforce` refuses to start, naming rules

```text
error: --kernel-sandbox=enforce refuses to start: the OS can't hold these rules here:
  - …
Use --kernel-sandbox=warn to run with Deno's checks only, or --kernel-sandbox-report for the whole policy.
```

**Cause:** a listed rule would be held more loosely than by Deno (a `fail-open` gap), even with
the Mode B supervisor. The common ones follow. **Fix:** change the rule as each entry says, or run
with `warn`.

### No Landlock or no seccomp filter here (Linux)

**Cause:** the kernel is older than 5.13, Landlock isn't in its security-module list, or a
container's or outer sandbox's seccomp profile refuses the calls the sandbox needs. **Fix:** a newer
kernel or a container profile that allows Landlock and a nested seccomp filter, or no `enforce`
there. `deno info --json` shows `landlockAbi` and `capabilities.seccomp`.

### A read deny inside an allow refuses to start

**Cause:** a read deny inside a read allow is held by expanding the folders around it, and the
walk stops at 20,000 entries or 64 levels. **Fix:** narrow the read allow (for example `./src`
instead of `.`), or move the denied file out of the large tree.

### `deno repl` or a test run refuses to start

```text
error: --kernel-sandbox=enforce is not supported for this command yet: it can't apply the sandbox before user code runs, so it refuses to start
```

**Cause:** `enforce` covers `run`, `serve`, `test` and `bench`. The REPL, Jupyter, `eval` with a
deny rule and a `deno test` that loads a Vitest or Jest config refuse rather than run unconfined,
and `deno x` refuses a package's native executable. This bites most often when `deno.json` says
`"kernelSandbox": "enforce"`, which applies to every command that runs your code in the project,
`denext dev` included (a watched, hot-reloading run isn't fixed, so it refuses too). `deno lint`
and the language server are the exception: their lint plugins run with no kernel sandbox at all
(`deno lint` warns), so the key neither covers nor refuses them. **Fix:** remove the key (or set it
to `warn`) and put `--kernel-sandbox=enforce` on the start command.

### A program from stdin is refused

```text
error: --kernel-sandbox=enforce can't run a program read from stdin yet (the sandbox re-executes the process); save it to a file
```

**Cause:** the sandbox re-executes the process, and stdin can't be read twice. **Fix:** save the
program to a file.

### `enforce` refuses inside another sandbox on macOS

**Cause:** a process already under a Seatbelt profile (App Sandbox, an agent's or editor's sandbox,
`sandbox-exec`) can't apply another. **Fix:** run outside the outer sandbox, or use `warn` there.

### `deno compile --kernel-sandbox=enforce` or `broker` is refused

**Cause:** the target has no enforcer for it: `enforce` for a target other than Linux, macOS or
Windows, `broker` for Windows or for a desktop app (no supervisor runs there). **Fix:** compile with
`enforce` where `broker` was refused, or with `warn`, `auto` or `off`.

### A compiled program refuses to start on a Windows write grant

**Cause:** the small tier labels each write folder Low, which is persistent, so it refuses a grant
on a drive root, the profile folder, the Windows folder or a system-wide program folder. **Fix:**
grant narrow data folders.

## Failures while running

### A child is missing environment variables

**Cause:** under `enforce` the environment is scrubbed to the `--allow-env` names plus `PATH`,
`HOME`, `TMPDIR`, `DENO_DIR`, `LANG`, `LC_*`, `TZ`, the proxy variables, `NO_COLOR` and `TERM`, and
children inherit only that. `git` without `SSH_AUTH_SOCK`, a build without `CI` or `NODE_ENV`, a
tool without its token. **Fix:** grant each one, `--allow-env=SSH_AUTH_SOCK,CI`. The report's `env:`
line shows what's kept.

### `chmod`, `cp -p`, `tar` or git's executable bit fails (Linux)

**Cause:** under `enforce`, chmod, chown, utime and extended-attribute writes by path are refused
everywhere, inside the write scope too: `Deno.chmod`, `Deno.utime`, `cp -p`, `tar` extracting
modes, `git checkout` setting `+x`. They fail with `EPERM`. **Fix:** in your own code, open the file
and use a descriptor form (`node:fs`'s `fchmod` / `futimes`, `Deno.FsFile`'s `utime()`); for tools,
run that step without `enforce` (or `cp` without `-p`).

### A custom registry or token from `.npmrc` is ignored

```text
Warning kernel sandbox: /home/me/.npmrc isn't readable under --kernel-sandbox=enforce, so it is treated as absent (it may hold registry tokens): …
```

**Cause:** `.npmrc` can hold registry tokens, so the confined process never reads it unless the
grant names it; the report names it on a `skipped:` line. **Fix:** run once without `enforce` to
cache the packages, then run under `enforce`; or grant the file with `--allow-read=<path>/.npmrc`
if you accept that native code in the run can read the token.

### A dynamic remote `import()` fails

**Cause:** the module wasn't cached before the sandbox started. On Linux the confined process reads
remote modules from the cache only ("not found in cache"); on macOS `DENO_DIR` is read-only inside
the sandbox. **Fix:** `deno cache` the module first, or import it statically.

### A file created after start can't be read (Linux)

**Cause:** it was created in a folder expanded for a read deny; entries are given rules at startup,
so a new one has none. **Fix:** create such files in a folder without a deny beside them, or move
the deny.

### `git fetch`, `curl` or an addon has no network

**Cause:** the network grant is held by the Mode B supervisor (a host name in `--allow-net`, a
`--deny-net`, a Unix socket by path or a port list on an older Linux kernel). The supervisor makes
the program's own sockets; native code and child processes other than `deno` can't open one.
**Fix:** grant the network by IP address and port (Mode A, held by port), grant all network, or
run that step without `enforce`.

### UDP, QUIC or a WebRTC connection fails

**Cause:** under a host-scoped grant the supervisor refuses UDP sockets (`Deno.listenDatagram`,
`node:dgram`, QUIC, WebRTC's UDP candidates), because a UDP socket can't be held to one peer. A DNS
query to a name server the grant names still works. **Fix:** grant those addresses without host
names, or run without `enforce`.

### A granted host name is refused

**Cause:** the supervisor resolved it to an address on this machine or its networks (loopback, a
private range, a link-local address), which a public name may not lead to. **Fix:** add that
address (or its subnet) to the grant if it's meant to be reached.

### A signal reaches the program twice, or `sd_notify` is ignored

**Cause:** under Mode B the process the launcher started is the supervisor, which passes on the
signals sent to it. A signal sent to the whole process group or control group (systemd's default
`KillMode=control-group`) reaches the program directly too; `sd_notify` comes from a process that
isn't the main PID. **Fix:** make the program's shutdown handler idempotent, or use
`KillMode=mixed`; set `NotifyAccess=all`.

### A browser or `sandbox-exec` fails under `warn` on macOS

**Cause:** `warn` asked for by name applies a report-only Seatbelt profile, and a program that
applies a sandbox of its own fails under any profile. **Fix:** `DENO_KERNEL_SANDBOX_WARN_OBSERVE=0`.

### A library outside `--allow-ffi` still loads

**Not a refusal, a documented gap:** on Linux and macOS library loading is bounded by the read
scope, not by the `--allow-ffi` list. Keep a library you don't want loaded out of the read scope.

### Native code reaches another host or address on a granted port

**Documented gap:** in Mode A a port list of IP addresses or `localhost` is held by port on Linux
and macOS (any address on those ports, `169.254.169.254` included). Run with
`--kernel-sandbox=broker` to hold it exactly, or block what must stay unreachable outside the
process (a firewall, the container's network policy).

### Other symptoms

Planned entries:

- `git` fails: it can't read `~/.gitconfig`, `~/.ssh/known_hosts` or its credential helper socket.
- A compiler fails writing its temp files.
- `sudo`, `ping` or another setuid helper fails.
- Headless Chrome, Puppeteer or Playwright fails to start without `--no-sandbox`.
- Docker or Podman commands fail: the Docker socket or rootless helpers.
- A native addon fails to load: it extracts itself to a folder that isn't granted.
- Moving files between two write folders fails on an older Linux kernel (Landlock ABI 1).
- `strace` or `gdb` can't attach.
- Running inside a container, WSL or gVisor reports no Landlock.

## npm packages that need extra grants

_Being written as this lands._ Known packages and the grant each needs (prebuilt native addons
that extract to a cache folder, tools that download browsers or engines, packages that spawn their
own binaries), shared with `denext doctor`'s list.

## Reporting a compatibility problem

_Being written as this lands._ What to include (the report output, `deno info --json`, the
platform and kernel), and the difference between a compatibility problem (an issue) and an escape
(a private security report: see the
[threat model](/docs/kernel-sandbox-threat-model#reporting-a-sandbox-escape)).
