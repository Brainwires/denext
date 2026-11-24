---
title: Kernel sandbox on Linux
slug: kernel-sandbox-linux
lead: How the kernel sandbox holds a grant on Linux. Landlock for files and TCP ports, seccomp for system calls, and the supervisor for rules neither can express. What each Landlock ABI adds, and what changes in containers and on WSL.
---

> [!IMPORTANT]
> **An opt-in preview ships in denext 4.x; automatic enforcement lands in denext 5.0.**
> `--kernel-sandbox=enforce` confines `deno run`, `deno serve`, `deno test` and `deno bench` on
> Linux x86_64 and aarch64 today (Landlock and seccomp, with the Mode B supervisor for the rules
> they can't hold), and so does a program compiled with it; the rest of this page is filled in as
> the remaining parts land. The
> [overview](/docs/kernel-sandbox#every-kernel-denext-runs-on-today-keeps-working) has the
> per-kernel table.

## How a Linux process confines itself

Under `--kernel-sandbox=enforce`, `deno run` and `deno serve` resolve the grant and load the
program's static module graph (remote modules cached), then re-execute themselves with the same
arguments (`deno test` and `deno bench` type-check and find their modules first, and the confined
image runs exactly those). The new image applies `no_new_privs`, the Landlock ruleset and one seccomp filter first
thing, while it has a single thread, so every thread and child it ever has is inside the sandbox.
The process ID stays the same, so signals, supervisors and `$!` keep working. The new image checks
that the policy it was handed is the one it compiles itself, and refuses to start otherwise.

Under Mode B the re-executed image is the supervisor instead: it keeps the PID, forks the confined
program and serves its requests. The program ends with the supervisor. See
[Mode B in detail](/docs/kernel-sandbox-modes#mode-b-broker-in-detail).

What the re-exec changes:

- **The environment is scrubbed.** Without an unscoped `--allow-env`, the new image keeps only the
  `--allow-env` names plus `PATH`, `HOME`, `TMPDIR`, `DENO_DIR`, `LANG`, `LC_*`, `TZ`, the proxy
  variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, either case), `NO_COLOR` and
  `TERM`. Child processes inherit only that set. A variable a child needs (`SSH_AUTH_SOCK`, `CI`,
  `NODE_ENV`, a token) must be granted: `--allow-env=CI,NODE_ENV`. The report's `env:` line lists
  what's kept.
- **A program read from stdin is refused**: it can't be read twice. Save it to a file.
- **Remote modules come from the cache only.** A dynamic `import()` of a remote module that wasn't
  cached fails with "not found in cache". Run `deno cache` on it first.
- **Your project's files stay readable** where Deno loads them itself: the program's local modules
  and the config files discovery read (every `deno.json` / `package.json` of the workspace, the
  import map, the lockfile), even outside the read grant. `.npmrc` is never among them: it can hold
  registry tokens, so it's treated as absent ([below](#npmrc-under-enforce)).

Compiled programs know their grant before any thread starts, so they confine themselves in place
without the extra exec (a program whose grant needs the supervisor forks first). See
[Desktop and compiled apps](/docs/kernel-sandbox-desktop-and-compiled).

## Files: Landlock

_Being written as this lands._ How `--allow-read`, `--allow-write` and execution map to Landlock
rules, ABI by ABI, and how symlinks are handled (Landlock checks the real file, not the name).

### Deny rules inside an allowed folder

Landlock rights only add up down the tree, so "this folder except `.env`" can't be written as one
rule.

- **A read deny inside a read allow** is held by **expansion**. At startup Deno walks the allowed
  folder and gives each entry beside the denied path its own rule, folder by folder down to the
  deny. Three consequences:
  - a file or folder created in an expanded folder after start is unreadable (a `fail-closed`
    gap);
  - a symlink in an expanded folder gets no rule (a rule would follow the link, and grant wherever
    it leads), so it can't be read through;
  - the walk stops at 20,000 entries or 64 levels, and `enforce` then refuses to start. Narrow the
    allow, or move the denied file out of a large tree.
- **A write deny inside a write allow** is held by Mode B. The kernel gives no write rule to the
  folders on the way to the deny, only to each entry beside them, so it refuses changes directly in
  those folders and in folders made after start: native code and children get that fail-closed
  view. Deno's own operations there are asked of the supervisor, which holds the deny exactly. It
  refuses a recursive removal or a rename of a folder that holds a denied path.

### What Landlock doesn't cover

The kernel documentation lists operations Landlock doesn't restrict. The one that matters most
here: changing a file's mode, timestamps or extended attributes. seccomp sees only that `chmod`
was called, not which file it names, so under `enforce` it refuses the **path forms** of chmod,
chown, utime and extended-attribute writes everywhere, **inside the write scope too**. That breaks:

- `Deno.chmod`, `Deno.utime` and `node:fs`'s `chmod` / `utimes` by path;
- `cp -p`, `tar` extracting with modes or times, `rsync -a`;
- `git checkout` or `git clone` setting a file's executable bit.

They fail with `EPERM`. The descriptor forms (`fchmod`, `futimens`, a `Deno.FsFile`'s `chmod` and
`utime`) still work, on any file the process can open, which includes the read scope: there,
changing a file's mode or times stays Deno-only. Contents outside the grant stay protected. The
[guarantee matrix](/docs/kernel-sandbox-guarantees) has the cell.

### `.npmrc` under `enforce`

`.npmrc` can hold registry tokens, so the confined process can never read it unless the grant
names it. It's treated as absent: a custom registry or token from it is unavailable, Deno prints
one warning, and `--kernel-sandbox-report` names each such file on a `skipped:` line. Two ways out:

- run once without `enforce` (`deno install`, or the same `deno run`) so the packages are cached,
  then run under `enforce`;
- or grant the file, `--allow-read=/home/me/.npmrc`, if you accept that native code in the run can
  read the token.

## System calls: seccomp

_Being written as this lands._ The list of refused calls and why each is refused (`ptrace`,
`process_vm_*`, `bpf`, `perf_event_open`, `userfaultfd`, the keyring calls, the mount family, new
user namespaces, `kexec`, module loading, `io_uring`, terminal injection `ioctl`s, the 32-bit
compatibility interfaces), based on Docker's default profile. Refused calls return an error (never
kill the process), so they surface as catchable errors in JavaScript.

## Network

- **No network:** sockets refused by seccomp.
- **All network:** allowed.
- **A port list of IP addresses or `localhost`** on Landlock ABI 4 (Linux 6.7) and later: Landlock
  port rules. They hold the port, not the address, so native code and children may reach any
  address on those ports, `169.254.169.254` included (a `documented` gap). On an older kernel
  `enforce` holds the list through Mode B, and `--kernel-sandbox=broker` does on any kernel.
- **Host names** (`--allow-net=api.example.com:443`) and `--deny-net` are held by Mode B: the
  supervisor resolves the name, checks it, connects and passes the socket back. The confined
  process can't make a network socket, `connect` or `listen` of its own, so native code and child
  processes (other than `deno`) have no network, and UDP is refused under a host-scoped grant.
- **Listen-only grants.** An `--allow-net-listen` list whose every entry is an address with a port
  (`127.0.0.1:8000`, `localhost:9000`, `0.0.0.0:8080`; not a name, a subnet or port 0) is bound
  and listening before the sandbox applies, and each listener is handed to the operation that
  listens there (`Deno.listen`, `Deno.serve`, `node:net`). The addresses stay bound for the life of
  the process, an address that can't be bound reports its error when the program listens there,
  and UDP on them is refused. Not with `--inspect` or under Mode B.

## Unix sockets and signals

Landlock can't scope a socket connect by path, so a Unix socket granted by path
(`--allow-net=unix:<path>`) is connected by the Mode B supervisor. Sockets the grant doesn't name
are refused in Mode A, even inside the read and write scope. _Being written as this lands:_ what ABI 6 adds
for abstract sockets and signals, and what stays open before it.

## Subprocesses on Linux

_Being written as this lands._ What children inherit, the system folders added when `run` is
granted, and what no longer works inside (setuid helpers, rootless containers, Chrome's own
sandbox, `strace`).

## Containers

Docker's default seccomp profile allows the Landlock system calls and a nested seccomp filter, so
**enforcement works in a default Docker container**. Landlock and seccomp stack with the
container's own confinement, and with a systemd unit's `NoNewPrivileges=` and `ProtectSystem=`.

What doesn't work in a default container is anything that needs a new **user namespace**, because
the default profile refuses to create one:

- hiding denied paths by mounting over them (design: not built yet; today a read deny inside a
  read allow is held by [expansion](#deny-rules-inside-an-allowed-folder) everywhere);
- Chrome's own namespace sandbox (run headless Chrome with `--no-sandbox`, as you already do in
  Docker).

The same applies on distributions that restrict unprivileged user namespaces (Ubuntu 24.04 does
this through AppArmor by default). Nothing in today's `enforce` depends on user namespaces, so it
behaves the same there.

gVisor and some Firecracker setups don't offer Landlock at all, so the "no Landlock" case applies:
seccomp only, and files Deno-only. WSL2 depends on how its kernel is built and **hasn't been
verified yet**. `deno info --json` says whether Landlock is present (`landlockAbi`).

## Check your own system

`deno info --json` reports the Landlock ABI (`kernelSandbox.landlockAbi`) and the machine's
capabilities, among them whether user namespaces are available
([field reference](/docs/kernel-sandbox-modes#deno-info---json--kernelsandbox)). You can also check
by hand.

The kernel version:

```sh
uname -r
```

Whether Landlock is enabled (look for `landlock` in the list):

```sh
cat /sys/kernel/security/lsm
```

The Landlock ABI. This calls `landlock_create_ruleset` with the flag that asks for the version.
`444` is that system call's number on x86_64 (aarch64 uses the same number). It prints the ABI, or
`-1` when Landlock isn't available:

```sh
python3 -c 'import ctypes;l=ctypes.CDLL(None);print(l.syscall(444,None,0,1))'
```

Whether unprivileged user namespaces are restricted (an AppArmor restriction of `1`, or a
`max_user_namespaces` of `0`, means the overmount method is unavailable):

```sh
sysctl kernel.apparmor_restrict_unprivileged_userns user.max_user_namespaces
```

For a confined process, `/proc/<pid>/status` shows `NoNewPrivs: 1` and a non-zero `Seccomp:` line.

_Being written as this lands:_ reading kernel audit records of refusals on 6.15 and later.
