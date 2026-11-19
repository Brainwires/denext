// A detached sidecar (tests/desktop-sidecar-detached.test.ts): serves its port, reports its
// attachments and its shutdown on stdout (the sidecar's log file), and says it is ready.
const sc = globalThis.denextSidecar;
console.log(
  "started " + JSON.stringify({
    name: sc.name,
    child: sc.child,
    port: sc.port,
    secrets: Object.keys(sc.secrets),
    bootstrap: sc.bootstrap,
    attached: sc.detached.attached,
    argv: (await import("node:process")).default.argv.slice(2),
  }),
);
if (sc.port) {
  Deno.serve({ hostname: "127.0.0.1", port: sc.port, onListen() {} }, () => new Response("ok"));
}
sc.detached.onAttachedChange((attached) => console.log("attached " + attached));
sc.onShutdown(() => console.log("shutdown handler"));
sc.ready();
