// A detached sidecar (tests/desktop-sidecar-detached.test.ts): records its pid, serves its port,
// reports its attachments and its shutdown on stdout (the sidecar's log file), and says it is
// ready.
const sc = globalThis.denextSidecar;
const proc = (await import("node:process")).default;
// The test's pid folder (its argument): the test asks the OS whether each recorded pid still
// runs, on every platform (no `pgrep`).
const pidDir = proc.argv[2];
if (pidDir) {
  Deno.mkdirSync(pidDir, { recursive: true });
  Deno.writeTextFileSync(`${pidDir}/${Deno.pid}`, "");
}
console.log(
  "started " + JSON.stringify({
    name: sc.name,
    child: sc.child,
    port: sc.port,
    secrets: Object.keys(sc.secrets),
    bootstrap: sc.bootstrap,
    attached: sc.detached.attached,
    argv: proc.argv.slice(2),
  }),
);
if (sc.port) {
  Deno.serve({ hostname: "127.0.0.1", port: sc.port, onListen() {} }, () => new Response("ok"));
}
sc.detached.onAttachedChange((attached) => console.log("attached " + attached));
sc.onShutdown(() => console.log("shutdown handler"));
sc.ready();
