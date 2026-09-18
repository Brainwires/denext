// `denext ui --offline`, said once. The contract: nothing the UI starts reaches the network.
// Every denext-CLI child (the commands listing, a verb run, `denext doctor`) runs under
// `--deny-net --cached-only` (`proc.ts`), and the wizard's `deno install` under `--cached-only`.
// The two discovery children (`commands --json`, `task --list --json`) add `--deny-run`, so the
// config they evaluate cannot spawn its way around `--deny-net`; a verb run and `doctor` keep
// `--allow-run`, so a process one of THOSE starts is the one thing the flags do not reach.
// An operation no flag can keep off the network is refused instead — with the status, and the
// kind of reason, `op=add-jsr` gives when JSR may not be queried (`features/plugin-search.ts`).

/** The status an operation refused under `--offline` answers with (as `op=add-jsr` does). */
export const OFFLINE_STATUS = 503;

/** Why each operation the UI cannot run offline is refused, keyed by operation. */
export const OFFLINE_REFUSALS = {
  /** `/tasks/run`: a task is arbitrary shell. */
  task: "deno task is unavailable — the UI runs --offline, and a task is arbitrary shell " +
    "that no flag can keep off the network.",
  /** The wizard's "Start denext dev". */
  dev: "denext dev is unavailable — the UI runs --offline, and a dev server needs net " +
    "permission to listen.",
  /** A catalogue add. */
  add: "deno add is unavailable — the UI runs --offline, and adding a package needs the registry.",
  /** A catalogue remove. */
  remove: "deno remove is unavailable — the UI runs --offline, and removing a package can " +
    "re-resolve the remaining dependencies over the network.",
} as const;
