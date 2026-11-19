---
title: Kernel sandbox on Linux
slug: kernel-sandbox-linux
lead: How the kernel sandbox holds a grant on Linux. Landlock for files and TCP ports, seccomp for system calls, and the supervisor for rules neither can express. What each Landlock ABI adds, and what changes in containers and on WSL.
---

> [!IMPORTANT]
> **An opt-in preview ships in denext 4.20; the full sandbox, with automatic enforcement, lands
> in denext 5.0.** `--kernel-sandbox=enforce` confines `deno run` and `deno serve` on Linux
> x86_64 and aarch64 today (Mode A: Landlock and seccomp); the rest of this page is filled in as
> the remaining parts land. The
> [overview](/docs/kernel-sandbox#every-kernel-denext-runs-on-today-keeps-working) has the
> per-kernel table.

## How a Linux process confines itself

Under `--kernel-sandbox=enforce`, `deno run` and `deno serve` resolve the grant and load the
program's static module graph (remote modules cached), then re-execute themselves with the same
arguments. The new image applies `no_new_privs`, the Landlock ruleset and one seccomp filter first
thing, while it has a single thread, so every thread and child it ever has is inside the sandbox.
The process ID stays the same, so signals, supervisors and `$!` keep working. The new image checks
that the policy it was handed is the one it compiles itself, and refuses to start otherwise.

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

Compiled binaries and desktop apps (design) know their grant before any thread starts, so they
will confine themselves without the extra exec. Today `deno compile --kernel-sandbox=enforce` is
refused.

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
- **A write deny inside a write allow** needs Mode B, which isn't built yet, so `enforce` refuses to
  start over it. Scope the write grant to the folders that should be writable instead.

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
  address on those ports, `169.254.169.254` included (a `documented` gap). On an older kernel a
  port list is a `fail-open` gap and `enforce` refuses to start.
- **Listening only** (`--allow-net-listen=127.0.0.1:8000,localhost:9000`, every entry an address
  with a port): the addresses are bound before the sandbox applies and handed to whatever listens
  there (`Deno.serve`, `Deno.listen`, `node:net`, `node:http`). The confined process then has no
  network access of its own, on every kernel, and the address is held, not just its port. See
  [Listeners bound at startup](#listeners-bound-at-startup).
- **Host names** (`--allow-net=api.example.com:443`) need Mode B, where the supervisor resolves the
  name, checks it, connects and passes the socket back. Mode B isn't built yet, so `enforce`
  refuses to start over a host-scoped grant on Linux. Grant by IP address, all network, or run
  without `enforce`. [What Mode B holds](#host-scoped-network-under-mode-b) describes the design.

### Listeners bound at startup

With `--allow-net-listen` naming addresses (`127.0.0.1:8000`, `0.0.0.0:8080`, `localhost:9000`,
which is both loopback addresses), `enforce` binds each one, listening, before it confines the
process. `--kernel-sandbox-report` lists them:

```
net:        denied
listeners:  bound before the sandbox applies: 127.0.0.1:8000
```

What follows from that:

- The address is bound from startup for the life of the process, whether or not the program
  listens there. A client that connects before the program accepts waits; it isn't refused.
- Listening again after a close works, and so do several listeners on one address (`reusePort`,
  `deno serve --parallel`): each gets the same socket.
- An address that can't be bound at startup (in use, no IPv6 on the machine) doesn't stop the run.
  Listening there reports that error.
- UDP on those addresses is refused.
- An entry that can't be bound ahead keeps the port rules above: a host name, a subnet, a bare
  host, port `0`. So does a run with `--inspect`.
- Only `--allow-net-listen` is bound ahead. An `--allow-net` entry is as often a server to connect
  to (`--allow-net=localhost:5432`), and the sandbox must not take its port.

### Host-scoped network under Mode B

_Being built: it works where `deno info --json` reports `kernelSandbox.brokerNetBuilt`._ No kernel
filters by host name, so under Mode B the confined process makes no network socket itself. Every
socket comes from the supervisor, which holds the grant:

- **Names are resolved by the supervisor,** and only names the grant holds. Each connection goes to
  exactly the address that was checked.
- **A granted name can't lead inside.** If `api.example.com` resolves to a loopback, private or
  link-local address (`169.254.169.254` included), the connection is refused unless the grant also
  names that address (`--allow-net=db.internal:5432,10.0.0.0/8:5432`). That closes DNS rebinding
  from a granted public name to your own machine or a cloud metadata service. `localhost` leads to
  loopback only.
- **Listening** sockets are bound by the supervisor and handed over.
- **UDP** (`Deno.listenDatagram`, `node:dgram`, QUIC, WebRTC's UDP candidates) is refused under a
  host-scoped grant: a UDP socket can send to any address, so it can't be held to the grant.
  `Deno.resolveDns` still works with a name server the grant names (the supervisor carries each
  query out).
- **Native code** has no socket that reaches an address: it can't make one, and `connect` is
  refused for the whole process tree, so a socket the supervisor handed over can't be pointed
  somewhere else.
- **Child processes** have no network under a host-scoped grant. (Planned: an allow-listing proxy
  the supervisor runs, which `HTTP_PROXY` and `HTTPS_PROXY` point at.)
- **Not carried by the supervisor yet:** remote modules imported after startup that aren't in the
  cache, the OpenTelemetry exporter, `Deno.cron`'s control socket, named pipes of `node:net`.
  These fail under Mode B; none is a way out.

## Unix sockets and signals

_Being written as this lands._ Why pathname Unix sockets need an explicit grant (or Mode B), what
ABI 6 adds for abstract sockets and signals, and what stays open before it.

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
