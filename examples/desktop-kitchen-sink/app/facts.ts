// The session facts the runtime reports, gathered in one object for the window test's output and
// results file and for the drive mode's `probe` command: the runtime's own session probe
// (`Deno.desktop.platformFeatures()`, read by the `kitchen` extension in the app's Deno process),
// and what the page's APIs make of it (`appCapabilities()`, `windowCapabilities()`).
//
// Imported by "use client" components only.

import { appCapabilities, isDesktopBridgeError } from "denext/desktop/app";
import { desktopExtension } from "denext/desktop/client";
import { windowCapabilities } from "denext/desktop/window";

const kitchen = desktopExtension("kitchen") as unknown as Record<
  string,
  (args?: unknown) => Promise<unknown>
>;

/** An error as one line: a bridge error's code, message and data, else its message. */
export function describeError(err: unknown): string {
  if (isDesktopBridgeError(err)) {
    const data = err.data === undefined ? "" : ` ${JSON.stringify(err.data)}`;
    return `${err.code}: ${err.message}${data}`;
  }
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** The facts, each one `{ error }` when it could not be read (never a rejection). */
export interface ProbeFacts {
  /** `{ available, features }` from `Deno.desktop.platformFeatures()` (runtime 2.9.7-denext.10+). */
  readonly platformFeatures: unknown;
  readonly appCapabilities: unknown;
  readonly windowCapabilities: unknown;
  readonly userAgent: string;
}

/** Read every fact. */
export async function probeFacts(): Promise<ProbeFacts> {
  const settle = (p: Promise<unknown>) => p.catch((err) => ({ error: describeError(err) }));
  return {
    platformFeatures: await settle(kitchen.features({})),
    appCapabilities: await settle(appCapabilities()),
    windowCapabilities: await settle(windowCapabilities()),
    userAgent: navigator.userAgent,
  };
}
