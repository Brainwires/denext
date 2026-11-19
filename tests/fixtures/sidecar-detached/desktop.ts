// The app entry of tests/desktop-sidecar-detached.test.ts. The detached launcher starts it again
// with DENEXT_SIDECAR_CHILD / DENEXT_SIDECAR_DETACHED set, and runDesktop then runs the sidecar's
// module as the detached process instead of a window.
import { runDesktop } from "../../../src/build/desktop.ts";

const app = await runDesktop({
  importMetaUrl: import.meta.url,
  sidecars: [{ name: "daemon", run: { module: "./daemon.mjs" }, detached: true }],
});
if (app.sidecarChild !== "daemon") throw new Error("this entry only runs as a sidecar's child");
