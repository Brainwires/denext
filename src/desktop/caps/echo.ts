/**
 * The `echo` diagnostic capability: a built-in used to check the desktop bridge end to end (RPC
 * round-trip and the event stream) without any OS access. Enabled with `desktop.capabilities.echo`
 * (off by default). It touches nothing native, so it needs no permissions.
 *
 * - `ping(args)` returns `{ echo: args, os, at }` — a request/response check.
 * - `emitPong(data)` pushes a `pong` event carrying `data` — an event-channel check.
 *
 * Runtime-only (imported by the desktop entry, never a client bundle).
 *
 * @module
 */

import type { DesktopCapability } from "../extension.ts";

/** The `echo` capability. */
export const echoCapability: DesktopCapability = {
  name: "echo",
  events: ["pong"],
  methods: {
    ping: {
      handler: (args, ctx) => ({ echo: args ?? null, os: ctx.os, at: Date.now() }),
    },
    emitPong: {
      handler: (args, ctx) => {
        ctx.emit("pong", args ?? null);
        return { emitted: true };
      },
    },
  },
};
