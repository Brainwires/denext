// One launch of an app with a detached sidecar (tests/desktop-sidecar-detached.test.ts), without a
// window: its sidecar host starts (or reattaches to) the detached sidecar, prints the status as a
// `STATUS {...}` line, then does what argv[0] says (`exit`: quit, leaving the sidecar running;
// `stop`: stop it first) and exits.
import { createSidecarHost } from "../../../src/desktop/sidecar-host.ts";

const [action, dataDir, marker, appVersion, extra] = Deno.args;
const options = JSON.parse(extra ?? "{}");
const host = await createSidecarHost({
  sidecars: [{
    name: "daemon",
    run: { module: "./daemon.mjs" },
    detached: options.detached ?? true,
    args: [marker],
    port: "auto",
    logs: "file",
    secrets: { token: "$random" },
    expose: { token: "$secret:token" },
    bootstrap: { hello: "world" },
    ready: { signal: true, timeoutMs: 60_000 },
    restart: { on: "never" },
    shutdown: { graceMs: 2_000 },
  }],
  importMetaUrl: new URL("./desktop.ts", import.meta.url).href,
  dataDir,
  appVersion,
  ...(options.pollMs ? { detachedRecordPollMs: options.pollMs } : {}),
});
host.startAll();
const handle = host.handle("daemon");
const status = await handle.whenReady(90_000);
console.log("STATUS " + JSON.stringify({ ...status, values: handle.info.values }));
if (action === "stop") {
  await handle.stop();
  console.log("STOPPED " + JSON.stringify(handle.status));
}
if (action === "list") {
  console.log("LIST " + JSON.stringify(await host.detachedSidecars()));
}
Deno.exit(0);
