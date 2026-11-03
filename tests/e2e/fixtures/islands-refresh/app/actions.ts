"use server";
import { forbidden, notFound } from "denext";
import { refresh } from "denext/server";
import { bumpHits } from "./store.ts";

/** Bump the server count and ask the client to re-render the current route in place. */
export async function bump(): Promise<void> {
  await Promise.resolve();
  bumpHits();
  refresh();
}

/** An action whose record is gone: the page's `gone/not-found.tsx` renders in place. */
export async function vanish(): Promise<void> {
  await Promise.resolve();
  notFound();
}

/** A `useActionState` action the caller may not run: `gone/forbidden.tsx` renders. */
export async function deny(_prev: string, _form: FormData): Promise<string> {
  await Promise.resolve();
  forbidden();
}
