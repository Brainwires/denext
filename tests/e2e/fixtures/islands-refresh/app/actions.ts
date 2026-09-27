"use server";
import { refresh } from "denext/server";
import { bumpHits } from "./store.ts";

/** Bump the server count and ask the client to re-render the current route in place. */
export async function bump(): Promise<void> {
  await Promise.resolve();
  bumpHits();
  refresh();
}
