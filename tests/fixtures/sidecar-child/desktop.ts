// The app entry of tests/desktop-sidecar-child.test.ts. A module sidecar's child runs it with
// DENEXT_SIDECAR_CHILD set, and runDesktop then runs the sidecar's module instead of a window.
import { runDesktop } from "../../../src/build/desktop.ts";

const app = await runDesktop({
  importMetaUrl: import.meta.url,
  sidecars: [{ name: "echo", run: { module: "./echo.mjs" }, env: { MODE: "desktop" } }],
});
if (app.sidecarChild !== "echo") throw new Error("this entry only runs as a sidecar's child");
