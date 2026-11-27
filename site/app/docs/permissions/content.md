---
title: Permissions
slug: permissions
lead: What Deno's --allow-* and --deny-* flags do and don't do under denext. They are least-privilege guardrails, not a sandbox. This page lists the grants that amount to full trust, the ones that expose secrets, and how network rules behave with an HTTP proxy.
---

denext runs your app under Deno's permission flags: the `start` task `denext create` writes, the
`denext build --compile` binary, the Docker image and systemd unit `denext deploy prepare` writes,
and a packaged desktop app each get a short `--allow-*` list instead of `-A`. That list is worth
having. It stops a lot of mistakes and makes a compromise harder. But read it for what it is.

## Least-privilege guardrails, not a sandbox

Deno's permissions are **checks inside Deno's own APIs**. `Deno.readFile`, `fetch`,
`Deno.connect`, `node:fs` and the rest ask the permission state before they act. Nothing below
those APIs is checked: the operating system does not know about the flags. So code that leaves
Deno's APIs leaves the checks behind:

- a subprocess (`--allow-run`) runs as a normal program, with the user's full rights;
- an FFI library (`--allow-ffi`) or a Node-API addon is native code in the same process, and can
  read memory, open files and make syscalls without asking.

Treat the flags as **least-privilege guardrails**: they narrow what your own JavaScript and its
dependencies can do through Deno, and they make an attacker work harder. They are not a boundary
that holds against code that is determined to get out, and they are not a replacement for running
the process as a low-privilege user, in a container, or behind a firewall.

Kernel enforcement of the same grants is **in development** for denext's Deno: Landlock and
seccomp on Linux, Seatbelt on macOS, a job object on Windows, and a supervisor for rules too fine
for the kernel. The full system, with automatic enforcement, lands in denext 5.0. denext 4.x
ships an opt-in preview, off unless you ask for it: `--kernel-sandbox=warn` and
`--kernel-sandbox-report` report, and `--kernel-sandbox=enforce` makes the operating system hold
the grant for `deno run`, `deno serve`, `deno test` and `deno bench` on Linux and macOS (and for a
program compiled with it), so FFI, addons and subprocesses are held to it too. Rules no kernel can
hold, such as a host name in `--allow-net`, run under a supervising broker (`broker`), and native
code and children then get no network of their own. `enforce` refuses to start over a rule it
would hold more loosely than Deno, and runs with the documented gaps its report lists (a port list
of addresses held by port, library loading bounded by the read scope). Don't set `enforce` in
`deno.json`: `denext dev` and the REPL refuse to start under it. See
[What `enforce` does today](/docs/kernel-sandbox#what-enforce-does-today). Outside an `enforce`
run, every permission on this site means "least-privilege guardrail".
One part already runs under the OS: an approved dependency's install script runs in the
[lifecycle-script jail](/docs/toolchain#supply-chain-lifecycle-script-jail), which uses Landlock
and seccomp on Linux and `sandbox-exec` on macOS where they are available. That covers install
scripts only, not your running app.

## Permission footguns

These grants give away more than their names suggest. Each one is worth a second look before it
goes into a `deno.json` task, a Dockerfile, `compile.permissions` or `desktop.extraPermissions`.

### `--allow-run` and `--allow-ffi` mean full trust

A program started with `--allow-run` is not bound by the parent's flags. If it is a shell, a
script interpreter (`sh`, `bash`, `powershell.exe`, `osascript`, `python`, `node`) or another
`deno`, it can do anything the user can. Scoping the flag to a program name (`--allow-run=git`)
narrows which programs start, not what they do, and many tools run other programs or read config
that runs code (git hooks, for one). `--allow-ffi`, and the `--allow-ffi` a Node-API addon needs,
load native code into the process; the permission checks do not apply to it.

Grant either only for code you would run with no flags at all.

### Write access to config files is code execution

A grant to write a file that something later executes, or reads as configuration, is a grant to
run code:

- `deno.json` / `deno.jsonc` (tasks, import maps, the `permissions` sets) and `package.json`
  (scripts);
- `.npmrc` (registry and script settings) and lockfiles;
- shell startup files (`~/.bashrc`, `~/.zshrc`, `~/.profile`, PowerShell profiles);
- git hooks (`.git/hooks/*`) and git config (`core.hooksPath`, `core.fsmonitor`);
- editor and tool configs that run commands, `denext.config.ts`, and any `.ts` / `.js` file the
  next run imports.

So `--allow-write=.` on a project directory is broad. Scope writes to the folders your app really
writes (a data directory, `.denext/`, an upload folder), as the least-privilege `start` task and
`desktop.permissions: "strict"` do.

### `--allow-net` to localhost reaches local services and cloud metadata

A loopback grant (`--allow-net=localhost`, `127.0.0.1`, or an unscoped `--allow-net`) reaches
every service listening on the machine: databases, Redis, a dev server, the Docker socket's TCP
port, admin consoles. An unscoped grant also reaches the cloud metadata endpoint
(`169.254.169.254` and its IPv6 and DNS forms) that hands out instance credentials. An allowed
host name connects to whatever address DNS returns for it, which can be a loopback or private
address. Grant the hosts you call by name and port; deny the metadata address
and other addresses you never call with `--deny-net`; and block them at the network layer too (a firewall, the metadata
service's hop limit, a proxy policy), not only with the flag.

`Deno.resolveDns()` checks the name servers it queries, not the names it looks up: once the
resolver is allowed, code can look up any name, and a lookup can carry data out.

### `--allow-env` exposes secrets

The environment is where most deployments keep their secrets: database URLs, API keys,
`SESSION_SECRET`, `DENEXT_ACTION_ID_SECRET`, cloud credentials. An unscoped `--allow-env` lets
every module read all of them, and pass them on to anything it may write to or connect to. Scope
it to the variables your app reads (`--allow-env=DATABASE_URL,PORT`), or on a packaged desktop app
use `desktop.permissions: "strict"` with the variables listed. Remember that a subprocess with
`--allow-run` inherits the environment unless you clear it.

### `--allow-read` of the home directory exposes credentials

The home directory holds keys and tokens: `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.kube`,
`~/.docker/config.json`, `~/.npmrc`, `~/.netrc`, `~/.gitconfig` credential helpers, shell
history, and browser profiles. An unscoped `--allow-read` (or one that includes `~`) reads them
all. Scope reads to the app's own directory and data, and `--deny-read` the credential folders if
a broad read is unavoidable.

### Symlinks and allow scopes

As of the runtime denext pins:

- **Allow scopes hold on the path an access reaches.** With `--allow-read=./data`, reading
  `./data/link` where the link points outside `./data` needs the target allowed as well (by its own
  scope, or at a prompt that names the resolved path). The same holds for writes: a dangling link or
  a linked directory inside a write scope can't create files outside it. Following accesses resolve
  every link; no-follow ones (remove, rename, `lstat`) resolve the parent, as the kernel does.
  `Deno.watchFs` and `node:fs` take the same checks. Older runtimes matched allow scopes
  against the path as written, so code that relied on reading through such a link now needs
  the target granted.
- **A scope covers its own resolved location.** A scope under a system link (macOS's `/tmp` ->
  `/private/tmp`, a temp folder under `/var`) or behind a project-folder link keeps working. A scope
  that is itself a link names the link: its target is covered only when the link is owned by root, so
  a link the user owns (`node_modules/x -> /elsewhere`) does not widen the scope.
- **Deny rules hold through links.** `--deny-read` / `--deny-write` are checked against the path
  a link resolves to, including a dangling link and a link in a parent directory, so a denied file
  stays denied however it is reached.
- **Creating a link needs unscoped grants.** `Deno.symlink()` and `node:fs`'s `symlink` need full
  read and write permission, so code under scoped grants can't plant a new link.

Not covered: the check resolves the path and the operation then opens it by name, so a link
swapped between the two (a time-of-check to time-of-use race) is followed without a new check. In a
folder other people or programs can write to, pair the allow with `--deny-*` rules for what must
stay out of reach. On Unix, an [external permission broker](#the-external-permission-broker) that
speaks protocol v2 closes that race for file opens: it opens the file and hands the descriptor
back.

## Linux `/proc` and `/sys` files

On Linux, reading a file under `/proc` or `/sys` takes the read grant on the path plus the
`--allow-sys` name for what the file holds, instead of `--allow-all`. This applies to every Linux
run, with nothing to turn on, and it only adds ways in: a run that worked before works the same. It
is part of Deno's checks, not of the [kernel sandbox](/docs/kernel-sandbox).

| Files                                                                                                                            | `--allow-sys` name |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `/proc/cpuinfo`, `/proc/stat`, `/sys/devices/system/cpu/**`; cgroup `cpu.*` / `cpuset.*` limit files                             | `cpus`             |
| `/proc/meminfo`; cgroup `memory.*` limit and usage files                                                                         | `systemMemoryInfo` |
| `/proc/loadavg`                                                                                                                  | `loadavg`          |
| `/proc/uptime`                                                                                                                   | `osUptime`         |
| `/proc/version`                                                                                                                  | `osRelease`        |
| This process: `status`, `stat`, `statm`, `maps`, `cgroup`, `limits` under `/proc/self`, `/proc/thread-self` or `/proc/<own pid>` | `processInfo`      |
| Any process: the `/proc` listing itself and `/proc/<pid>/{stat,status,cmdline,comm}`; cgroup `pids.*` files                      | `processes`        |

- The cgroup files are those under `/sys/fs/cgroup` ending in `.max` or `.current`.
- `processInfo` and `processes` are new names. Like the others they work in `--allow-sys`,
  `--deny-sys`, `deno.json` permission sets and `Deno.permissions.query({ name: "sys", kind })`.
- **`processes` exposes other processes' command lines**, which often carry secrets passed as
  arguments. Grant it only to code that needs the process list.
- `/proc/<pid>/environ` needs all of `--allow-env`. The control surfaces (`mem`, `root`, `cwd`,
  `exe`, `fd/*`, `map_files`, another process's `maps` or `limits`, `/proc/sys`, any write under
  `/proc` or `/sys`) still need `--allow-all`.
- A path is checked as written with `..` removed by name (`/proc/self/../1/mem` is `/proc/1/mem`),
  and a class holds only when the path with its links resolved is in the same class: a link out of
  `/sys/devices/system/cpu` (`cpu0/node0`) needs `--allow-all`.

```sh
deno run --allow-read=/proc --allow-sys=processInfo main.ts   # this process's /proc/self/status
```

## The external permission broker

An external permission broker is a program you run yourself: set `DENO_PERMISSION_BROKER_PATH` to
its Unix socket (a named pipe on Windows), and Deno asks it about each permission check instead of
using the flags or prompting. It is unrelated to the kernel sandbox's `broker` mode (the Mode B
supervisor). A run with an external permission broker can't use `--kernel-sandbox=enforce`, because
its grant isn't fixed.

**Protocol v2 (Unix)** lets the broker open the file itself and pass the descriptor back, so the
path can't be swapped between the decision and the open:

- A broker that puts `"v":2` in its first response speaks v2 for the rest of the connection.
  Without it the connection stays v1, which is unchanged: a v1 broker never sees anything new.
- After the permission check, each open by path (`Deno.open`, `readFile`, `writeFile`, `node:fs`
  opens) sends an `open` request: `{"v":2,"pid":N,"id":N,"datetime":"…","permission":"open","value":"/absolute/path","open":{"read":true,"write":false,"create":false,"createNew":false,"truncate":false,"append":false,"mode":null,"customFlags":null}}`.
- The broker answers `{"id":N,"result":"allow","fd":true}` with exactly one descriptor as
  `SCM_RIGHTS` data (Deno uses it instead of opening the path), `{"id":N,"result":"allow"}` (Deno
  opens the path itself) or `{"id":N,"result":"deny","reason":"…"}` (the open fails with
  `PermissionDenied`). Open with `O_NOFOLLOW` or `openat2(RESOLVE_BENEATH)`-style flags.
- Deno refuses a descriptor that is a socket, a symlink or (Linux) an `O_PATH` descriptor, a
  directory for a write or create, a different access mode than requested, or a file that isn't
  open on the requested path. A refused descriptor fails that open; the connection stays.
- A response line is at most 64 KiB and carries a descriptor only with `"fd":true`. Anything else
  is a malformed frame: Deno closes the connection and exits with code 87, as for any broker
  failure.
- Windows stays on v1: a broker's `"v":2` is ignored and no `open` request is sent.

## Network permissions and proxies

What this section says was checked against the runtime denext pins, with an HTTP proxy configured
through the environment.

**`fetch()` and `WebSocket`.**

- The proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, either case) are read
  once, before your code runs. Setting them later with `Deno.env.set()` changes nothing for
  `fetch()` or `WebSocket`.
- The permission check is made against the **destination** (the URL's host and port), allow and
  deny rules both, before any connection is opened, whether or not a proxy is used.
- Every redirect is checked again: a redirect to a host you have not allowed fails with
  `NotCapable`, through a proxy too.
- The connection to an HTTP or HTTPS proxy from the environment does not need an `--allow-net`
  grant: the proxy is the operator's configuration. A SOCKS proxy (`ALL_PROXY=socks5://…`) does
  need one for its host, and so does a proxy your code names itself with
  `Deno.createHttpClient({ proxy })`.
- A host matched by `NO_PROXY` is connected to directly, with the usual checks.
- A refusal on the way to the proxy reaches your code as `TypeError: fetch failed`, with the
  permission error in its `cause`.
- A proxied request can still look the destination name up through the local resolver, so the
  local DNS server may see the names your app calls.

**`node:http` and `node:https`.** These follow Node's rules: a proxy is used only with
`NODE_USE_ENV_PROXY=1` (or `--use-env-proxy`), `http.setGlobalProxyFromEnv()`, or an agent's
`proxyEnv` option, and `agent: false` never uses one. The variables are read when first needed,
without `--allow-env`. The request's target and the proxy host both need `--allow-net`. On denext's
Deno, once `node:http` has loaded, `fetch()` follows the same Node proxy configuration,
through a proxy client whose proxy host needs `--allow-net` too.

**`Deno.connect()`, `Deno.connectTls()`, `node:net`, `node:tls`.** No proxy support: they connect
directly, and the destination is checked as usual.

**npm clients with their own proxy agent.** A library that speaks the proxy protocol itself (an
`https-proxy-agent`, undici's `ProxyAgent`, a hand-written `CONNECT`) opens a socket only to the
proxy, so only the proxy is checked. The real destination is just bytes on that socket.

The rule that follows: **a grant to a proxy host is a grant to everything that proxy can reach.**
Allow a proxy only when you would allow its whole reach, and put the destination policy in the
proxy as well.

## How denext uses permissions

- **`denext task start` and the deploy outputs** run the server with no `--allow-run` and a write
  grant for `.denext` only, but with unscoped network, read and env access. Those three are broad
  (see the footguns above): narrow them to the hosts, folders and variables your app uses.
  [Deploying](/docs/deploy).
- **`denext build --compile`** bakes the same list into the binary, plus `compile.permissions`:
  [Deployment targets](/docs/deployment-targets).
- **Desktop apps** derive their flags from `desktop.capabilities`, and
  `desktop.permissions: "strict"` scopes reads and the environment:
  [Desktop apps](/docs/desktop#desktop-baked-permissions).
- **Install scripts** run in the OS-confined lifecycle-script jail:
  [Toolchain](/docs/toolchain#supply-chain-lifecycle-script-jail).

Every runtime-level permission change is listed in the
[runtime reference](/docs/runtime-reference#permissions-and-network-behavior).
