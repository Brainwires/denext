---
title: Kernel sandbox rollout and defaults
slug: kernel-sandbox-rollout
lead: What the kernel sandbox applies when you set nothing, context by context, at each stage of its rollout. What has to be true before a default changes, and how the soak in front of a change is counted.
---

> [!IMPORTANT]
> **In denext 4.x the stage is `preview`: with no setting, nothing is applied anywhere.** The two
> later stages belong to the release line after it. A runtime says which stage it is at in
> `deno info --json` (`kernelSandbox.stage`), and `denext kernel-sandbox` prints that stage's
> column of the table below.

## The defaults

`auto` is the mode a run has when nothing sets one. What `auto` applies depends on the run's
context and on the rollout stage of the runtime:

| Context                                                                    | `preview` | `r3`        | `r4`        |
| -------------------------------------------------------------------------- | --------- | ----------- | ----------- |
| A compiled program (`deno compile`, `denext build --compile`)              | off       | **enforce** | enforce     |
| A packaged desktop app with `desktop.permissions: "strict"`                | off       | **enforce** | enforce     |
| `denext start` (and the Docker image / systemd unit that run it)           | off       | **enforce** | enforce     |
| `auto` written out (`--kernel-sandbox=auto`, `"kernelSandbox": "auto"`)    | off       | **enforce** | enforce     |
| A bare `deno run` / `serve` with no terminal (CI, a pipe) or `--no-prompt` | off       | **warn**    | **enforce** |
| A run that can prompt (a terminal, prompting on)                           | off       | off         | off         |
| `-A` with no `--deny-*`                                                    | off       | off         | off         |
| `--watch`, HMR, `denext dev`, an external permission broker                | off       | off         | off         |

The idea behind the split: the sandbox can only narrow, so it may switch on by itself only where
**no prompt can widen the grant**. Among those runs there are two kinds.

- **The author fixed the permissions on purpose.** A compiled program bakes them in. A strict
  desktop package derives them from its capabilities. `denext start` runs the least-privilege set
  the scaffold writes. Someone who writes `auto` asked for it. These are tested by their authors
  with exactly that grant, so they are enforced first (`r3`).
- **The permissions are fixed by circumstance.** A bare `deno run --allow-run …` in a CI job has
  no terminal, so it can't prompt, but nobody decided that. These get one stage of warning (`r3`)
  before they are enforced (`r4`).

A run that can still prompt is never confined by a default: a prompt could widen the grant past
whatever the kernel was given. `-A` with no deny is never confined either: there is nothing to
narrow, and plain `-A` is promised no change at all.

### How each context gets its mode

| Context                  | Where the mode comes from                                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A compiled program       | Baked at compile time (`deno compile --kernel-sandbox=…`, else `deno.json`, else `auto`). The binary ignores the flag and `DENO_KERNEL_SANDBOX` at run time.                                                   |
| A strict desktop package | The packaging scripts bake the mode with the grant they derive from `desktop.capabilities`, once the desktop runtime has an enforcer ([desktop and compiled apps](/docs/kernel-sandbox-desktop-and-compiled)). |
| `denext start`           | The `start` task `denext create` and `denext migrate` write says `--kernel-sandbox=auto` once denext's own floor is a runtime that knows the flag. Written out, `auto` is the author's choice.                 |
| A bare run               | Nothing: the runtime decides from whether a prompt can happen (prompting on, and stdin and stderr are terminals).                                                                                              |

### A default never refuses to start

An `enforce` **you** write refuses to start when this machine's kernel can't hold a rule of the
grant: that is what asking for it means. A mode `auto` **chose** never does. Where enforcement
can't hold the grant, the run falls back to warn mode and says why, once:

```text
Warning kernel sandbox: auto can't enforce this run's permissions with the kernel here (1 rule(s) the OS can't hold here); it runs with Deno's checks only.
```

The cases:

| Why `auto` can't enforce                                                                                  | What the run does                                               |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| A rule the kernel can't hold here (a host-scoped `--allow-net` without the supervisor, an older Landlock) | Warn mode, with the rules listed.                               |
| A command `enforce` doesn't cover (`deno test`, `deno bench`, the REPL, a program read from stdin)        | Warn mode.                                                      |
| The process already runs inside an ancestor's kernel sandbox                                              | Nothing more: it inherits that sandbox, which already holds it. |
| The runtime has no enforcer for this platform or program kind                                             | Unchanged, and no notice.                                       |

So a default changing can make a run **report**, and can make native code or a child process be
**refused an access outside the grant**. It can't make a program that used to start stop starting.

### What sets the mode yourself

Any explicit setting wins over the table, in this order: a compiled program's baked mode, the
`--kernel-sandbox` flag, `DENO_KERNEL_SANDBOX` (`off` or `warn` only), `deno.json`'s
`permissions.kernelSandbox`. See [modes and configuration](/docs/kernel-sandbox-modes).

## What changes at each stage

**`preview` → `r3`:**

- Compiled programs, strict desktop packages, `denext start` and explicit `auto` are enforced
  where the grant can be held.
- A bare run with no terminal prints [one notice](/docs/kernel-sandbox-warn#the-warning-auto-prints-for-a-run-with-no-terminal),
  once per policy per machine, and only if it grants `--allow-run` or `--allow-ffi` or has a rule
  the kernel can't hold. Nothing is applied to it.

**`r3` → `r4`:**

- A bare run with no terminal is enforced where the grant can be held.
- `-A` with `--deny-*` rules is enforced for the denies, in the same contexts.
- Where the policy needs the Mode B supervisor and the runtime has it, it is used automatically.

[Preparing an app for enforcement](/docs/kernel-sandbox-migrating) is the guide for both.

## What has to be true before `r4`

The second change reaches every CI job, so it ships only when all of the following hold. The
runtime's repository has a script that checks them,
`tests/kernel_sandbox_beds/r4_preconditions.ts`; each line is `✓` (checked by the script), `✗`
(checked and failing), or `?` (a person records where the evidence is).

| #  | Precondition                                                                                                                                                                           | How it is checked                                                                         |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1  | The [guarantee matrix](/docs/kernel-sandbox-guarantees) is published, and the escape test corpus matches it on every kernel of the test matrix and every macOS version of the runners. | The corpus and the page exist (script); the matrix runs are recorded evidence.            |
| 2a | Every failure the test beds expect under forced enforcement is settled: fixed, documented, or an implicit-set entry with a test. None is still "to triage" or "to fix".                | Script, from the reviewed list.                                                           |
| 2b | Every bed has [soaked](#the-soak): the forced `enforce` bed, the forced `project` bed, and the bed that runs the suites with the `r4` defaults.                                        | Script, from the workflow's runs.                                                         |
| 3  | The startup cost is measured and inside the budget: at most 30 ms added to `deno run`, and no added exec for a compiled program or a desktop app.                                      | The script measures with a given binary; the matrix hosts' numbers are recorded evidence. |
| 4  | The first-failure message, `--kernel-sandbox-report`, `denext doctor`'s check and the `DENO_KERNEL_SANDBOX` switch exist and are documented.                                           | Script, in the runtime's source and these pages.                                          |
| 5  | `--watch`, HMR, `denext dev` and an external permission broker resolve to `off` at every stage, with tests.                                                                            | Script: the mode matrix has a row for each.                                               |
| 6  | No policy gap is silent: each prints in the report, `enforce` refuses the `fail-open` ones, warn mode reports them as startup refusals.                                                | The tests exist (script); the review of the gap list is recorded evidence.                |
| 7  | The [security policy](https://github.com/Brainwires/denext/blob/main/POLICIES.md#scope) states the boundary, and one dry-run advisory has gone through the private advisory process.   | Script for the policy text; the dry run is recorded evidence.                             |
| 8  | Stage `r3` shipped in the two runtime releases before, without a revert.                                                                                                               | Script, from the release tags; "no revert" is recorded evidence.                          |

The stage itself is one constant in the runtime. Moving it is a one-line change that the checks
above gate.

## The soak

Before a stage's defaults ship, whole test suites run with those defaults already switched on:
the runtime's spec tests, the Node.js compatibility suite, a matrix of npm packages with native
addons, and denext's own integration and end-to-end suites. A run of all of them, on Linux and
macOS, is a **full run** of a bed. There are four beds:

| Bed        | What is switched on                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| `enforce`  | Every `deno run` / `deno serve` of the suites runs under `enforce`, `-A` included, each with its own grant.  |
| `project`  | The same, and an unscoped read or write grant is narrowed for the kernel to the project and the temp folder. |
| `stage-r3` | Nothing forced: the suites run with the `r3` defaults.                                                       |
| `stage-r4` | Nothing forced: the suites run with the `r4` defaults.                                                       |

Each suite's failures are compared with a reviewed list. A failure that isn't on the list fails
the run.

A bed has **soaked** when all of this is true:

- **Seven green full runs in a row.** A full run that fails or is cancelled resets the count to
  zero. A partial run (one suite, or without macOS) is ignored either way.
- **Spread out.** A run counts only if it started four hours or more after the run counted before
  it. Seven runs dispatched together count as one. A soak therefore spans a day at least, across
  different times of day and states of the machines.
- **On the code that ships.** Every counted run is on the candidate commit or one of its
  ancestors, and the newest one is on the candidate commit itself.

The runs are started by hand. The project runs no scheduled CI, so the soak is counted in runs
instead of nights; the four-hour spacing keeps what nights gave, which is time between runs.
`tests/kernel_sandbox_beds/soak.ts` reads the workflow's runs, prints the ones that count and what
is missing, and prints the command that starts the next one.

## Where you see the stage

- `deno info --json` → `kernelSandbox.stage`: `preview`, `r3` or `r4`.
- `denext kernel-sandbox` prints the stage and its column of the defaults.
- `--kernel-sandbox-report` says why a mode applies: `auto: the author fixed the permissions (a
  compiled program, or auto set explicitly)` or `auto: no prompt can widen the grant here (no
  terminal, or --no-prompt)`.
