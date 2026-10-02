// Run a command holding denext's Cargo-style lock on an output directory of this repo, so two
// `deno task coverage:fallow` / `test:coverage` runs (two agents, a hook and a person) never
// delete each other's `coverage/` — the second prints
// `Blocking waiting for file lock on output directory coverage` and waits for the first.
//
//   deno run --allow-read --allow-write=.denext --allow-run --allow-env \
//     scripts/locked.ts coverage -- deno task coverage:fallow:run
//
// The lock is the one `denext test --coverage=<dir>` takes (`.denext/.denext-lock-<dir>`, an OS
// lock the OS drops when this process exits — see src/build/project-locks.ts). The child's exit
// code is this script's.

import { acquireProjectLocks } from "../src/build/project-locks.ts";

const sep = Deno.args.indexOf("--");
const dirs = sep < 0 ? [] : Deno.args.slice(0, sep);
const command = sep < 0 ? [] : Deno.args.slice(sep + 1);
if (dirs.length === 0 || command.length === 0) {
  console.error("usage: scripts/locked.ts <output-dir>... -- <command> [args...]");
  Deno.exit(2);
}

using _locks = await acquireProjectLocks({ projectDir: Deno.cwd(), outputDirs: dirs });
const [bin, ...args] = command;
const { code } = await new Deno.Command(bin === "deno" ? Deno.execPath() : bin, {
  args,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).output();
Deno.exit(code);
