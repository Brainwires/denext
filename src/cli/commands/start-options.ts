// What `denext start` and a `denext build --compile` binary share, so the binary serves exactly
// as `denext start` does: the `--port` / `--host` flags, the port (`--port`, else `$PORT`) and the
// production signal.

import type { CommandContext } from "../command.ts";
import { envGet } from "../../runtime/env-safe.ts";

/** `--port`/`--host` shared by the two serving verbs. */
export const SERVE_FLAGS = [
  {
    name: "port",
    alias: "p",
    type: "number",
    valueName: "<port>",
    help: "Port (default: 3000)",
  },
  {
    name: "host",
    altNames: ["hostname"],
    type: "string",
    valueName: "<host>",
    help: "Hostname",
  },
] as const;

/**
 * The port to listen on: `--port`, else the `$PORT` environment variable (what every PaaS —
 * Heroku, Cloud Run, Fly, Railway — injects), else undefined so the server auto-selects.
 */
export function portOf(ctx: CommandContext): number | undefined {
  if (typeof ctx.flags.port === "number") return ctx.flags.port;
  const env = Number(envGet("PORT"));
  return Number.isInteger(env) && env > 0 && env < 65536 ? env : undefined;
}

/**
 * `denext start` IS the production signal: when the deploy set neither `NODE_ENV` nor
 * `DENEXT_ENV`, set `DENEXT_ENV=production` so every "refuse in production" guard
 * (weak session secret, missing `canonicalOrigin`) actually fires under a plain
 * `deno task start`. A read-only env sandbox (`--allow-env=PORT`) leaves it unset.
 */
export function markProduction(): void {
  try {
    if (!Deno.env.get("NODE_ENV") && !Deno.env.get("DENEXT_ENV")) {
      Deno.env.set("DENEXT_ENV", "production");
    }
    // npm code (and an app's own env validation — the Epic Stack's zod schema requires it)
    // reads `process.env.NODE_ENV`; Remix's start script set it via cross-env, so do we.
    if (!Deno.env.get("NODE_ENV")) {
      Deno.env.set(
        "NODE_ENV",
        Deno.env.get("DENEXT_ENV") === "development" ? "development" : "production",
      );
    }
  } catch {
    // no env write permission — the deployer opted out of the signal
  }
}
