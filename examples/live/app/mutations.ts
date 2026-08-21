"use server";
import { revalidateTag } from "denext/server";
import { incr } from "./live-actions.ts";

// A "use server" mutation: it runs only on the server (the client imports a stub),
// so its server-only `revalidateTag` import never reaches the browser bundle.
// Bumping the count invalidates the "count" tag, which pushes a fresh value to
// every `useLive` subscriber over the socket — no polling, no refetch.
export function bump(): void {
  incr();
  revalidateTag("count");
}
