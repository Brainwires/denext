// denext's `server-only` package equivalent (aliased in by `denext migrate`).
//
// `server-only`'s real module throws "This module cannot be imported from a Client
// Component" so a client bundle that pulls it in fails LOUDLY. denext's PRIMARY
// enforcement is at BUILD time (the esbuild env-poison plugin errors when a client
// bundle imports `server-only`). As defense-in-depth — for any path that bypasses the
// build (a dynamic import, the deno-native loader) — this also throws at import time if
// it is ever evaluated in a CLIENT runtime, matching the npm package. It is inert on the
// server (SSR has no `document`), where `server-only` code legitimately runs.
import { serverOnly } from "../runtime/environment.ts";

serverOnly();

export {};
