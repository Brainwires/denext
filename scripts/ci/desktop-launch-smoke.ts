// CI smoke launch of a PACKAGED desktop app (Desktop CI's cross-launch jobs: a Linux bundle built
// on Windows, run on Linux under Xvfb; a Windows bundle built on Linux, run on Windows). Start the
// launcher, wait for the app's server to listen, check it stays up with its window, then stop it.
// The same signal `scripts/ci/desktop-run-smoke.ts` waits for, without the `desktop run` verb.
//
//   deno run -A scripts/ci/desktop-launch-smoke.ts <launcher>

const exe = Deno.args[0];
if (!exe) {
  console.error("usage: desktop-launch-smoke.ts <launcher>");
  Deno.exit(2);
}
const TIMEOUT_MS = Number(Deno.env.get("DESKTOP_LAUNCH_SMOKE_TIMEOUT_MS") ?? 120_000);
const STAY_UP_MS = 5_000;

const child = new Deno.Command(exe, { stdin: "null", stdout: "piped", stderr: "piped" }).spawn();
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

const sleep = (ms: number) => new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms));
const exited = child.status.then(() => "exited" as const);
const problems: string[] = [];
const outcome = await Promise.race([
  listening.then(() => "listening" as const),
  exited,
  sleep(TIMEOUT_MS),
]);
if (outcome === "listening") {
  // Up with its window: it must not die while the page loads.
  if (await Promise.race([exited, sleep(STAY_UP_MS)]) === "exited") {
    problems.push(`the app exited within ${STAY_UP_MS} ms of listening`);
  }
} else {
  problems.push(
    outcome === "timeout"
      ? `the app did not start listening within ${TIMEOUT_MS} ms`
      : "the app exited before it started listening",
  );
}
try {
  child.kill();
} catch { /* already gone */ }
const status = await child.status;
// A process the launcher started may hold the pipes open; don't wait on it forever.
await Promise.race([pumps, sleep(5_000)]);
if (/NotCapable/.test(output)) problems.push("the app hit a permission error (NotCapable)");

if (problems.length > 0) {
  console.error(`\n✗ ${exe} (exit ${status.code}):\n  - ${problems.join("\n  - ")}`);
  Deno.exit(1);
}
console.log(`\n✓ ${exe}: launched, listened and stayed up`);
Deno.exit(0);
