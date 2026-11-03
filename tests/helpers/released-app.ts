// `createApp` for in-process tests: the handler it returns has the bodies a test leaves unread
// cancelled when the test ends (tests/helpers/unread-bodies.ts), as a client that went away. A
// test that reads only a status otherwise leaves the request deadline's timer running, which the
// op sanitizer (on in deno.json) reports.

import { createApp as createAppUnreleased } from "../../src/server/app.ts";
import type { AppConfig, RequestHandler } from "../../src/server/app-config.ts";
import { releasingBodies } from "./unread-bodies.ts";

/**
 * {@linkcode createAppUnreleased} with its responses released after each test.
 *
 * @param config The app config.
 * @returns The request handler.
 */
export function createApp(config: AppConfig): RequestHandler {
  return releasingBodies(createAppUnreleased(config));
}
