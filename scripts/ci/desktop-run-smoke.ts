// CI smoke test for `denext desktop run` (macOS / Linux; Linux under a display, e.g. xvfb-run):
// run the verb on a project, wait until the launched app's server is listening, quit it the way
// Ctrl-C does, and check what the verb promises — a window process that started with its
// permissions (no `NotCapable`), a clean exit, no bundle left in the project folder, and the scratch
// build removed.
//
//   deno run -A scripts/ci/desktop-run-smoke.ts examples/native
//
// The package-script window test (examples/desktop-kitchen-sink) launches the PACKAGED app, so it
// never exercises this verb; this does.

import { join, resolve } from "@std/path";

const ROOT = resolve(import.meta.dirname!, "..", "..");
const project = resolve(Deno.args[0] ?? join(ROOT, "examples", "native"));
const TIMEOUT_MS = Number(Deno.env.get("DESKTOP_RUN_SMOKE_TIMEOUT_MS") ?? 600_000);

/** The project folder's entries (to spot a bundle the verb must not write there). */
async function entries(dir: string): Promise<Set<string>> {
  const names = new Set<string>();
  for await (const e of Deno.readDir(dir)) names.add(e.name);
  return names;
}

const before = await entries(project);
const child = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", join(ROOT, "cli.ts"), "desktop", "run", "."],
  cwd: project,
  stdin: "null",
  stdout: "piped",
  stderr: "piped",
}).spawn();

let output = "";
let resolveListening!: () => void;
const listening = new Promise<void>((r) => resolveListening = r);
const decoder = new TextDecoder();
async function pump(
  stream: ReadableStream<Uint8Array>,
  sink: { writeSync(b: Uint8Array): number },
) {
  for await (const chunk of stream) {
    sink.writeSync(chunk);
    output += decoder.decode(chunk, { stream: true });
    if (/Listening on /.test(output)) resolveListening();
  }
}
const pumps = Promise.all([pump(child.stdout, Deno.stdout), pump(child.stderr, Deno.stderr)]);

const problems: string[] = [];
let timer: number | undefined;
const outcome = await Promise.race([
  listening.then(() => "listening" as const),
  child.status.then(() => "exited" as const),
  new Promise<"timeout">((r) => timer = setTimeout(() => r("timeout"), TIMEOUT_MS)),
]);
clearTimeout(timer);
if (outcome === "listening") {
  // Let the window load, then quit as Ctrl-C would (the CLI forwards it to its re-exec'd child).
  await new Promise((r) => setTimeout(r, 5_000));
  child.kill("SIGINT");
} else {
  problems.push(
    outcome === "timeout"
      ? `the app did not start listening within ${TIMEOUT_MS} ms`
      : "the verb exited before the app started listening",
  );
  if (outcome === "timeout") child.kill("SIGKILL");
}
const status = await child.status;
await pumps;

if (outcome === "listening" && status.code !== 0) {
  problems.push(`the verb exited with ${status.code} after Ctrl-C (expected 0)`);
}
if (/NotCapable/.test(output)) problems.push("the app hit a permission error (NotCapable)");
if (!/Opening the desktop window/.test(output)) problems.push("the verb never opened a window");
const added = [...await entries(project)].filter((n) =>
  !before.has(n) && n !== "out" && n !== ".denext"
);
if (added.length > 0) problems.push(`left in the project folder: ${added.join(", ")}`);
const scratch = /into (\S+?)…/.exec(output)?.[1];
if (!scratch) problems.push("no scratch build directory was reported");
else if (await Deno.stat(scratch).then(() => true, () => false)) {
  problems.push(`the scratch build ${scratch} was not removed`);
}

if (problems.length > 0) {
  console.error(`\n✗ denext desktop run smoke test:\n  - ${problems.join("\n  - ")}`);
  Deno.exit(1);
}
console.log("\n✓ denext desktop run: built outside the project, launched, quit cleanly");
