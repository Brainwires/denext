// Real-browser e2e: a next-compat app on Auth.js v5 (no import map) hydrates in Chromium. Its
// client component and a `node_modules` library both use `next-auth/react`'s `useSession` from
// one SessionProvider; `signIn("credentials", { redirect: false })` signs in through the served
// handlers (CSRF token included) and every consumer updates, then `signOut` reverses it.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { stopNextCompat } from "../../src/build/next-compat.ts";
import { writeNextAuthCompatFixture } from "../helpers/next-auth-compat-fixture.ts";
import {
  assertNoConsoleErrors,
  buildAndServe,
  collectConsoleErrors,
  launchBrowser,
  pollFor,
} from "./harness.ts";

/** The text of `#id`, as a page expression. */
const text = (id: string) => `document.getElementById(${JSON.stringify(id)})?.textContent`;

Deno.test({
  name: "e2e: next-auth/react hydrates on the next-compat build, in the app and a library",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_nextauth_e2e_" });
  await writeNextAuthCompatFixture(dir);
  const browser = await launchBrowser();
  try {
    const server = await buildAndServe(dir);
    try {
      const page = await browser.newPage();
      const errors = collectConsoleErrors(page);
      await page.goto(`${server.origin}/`, { waitUntil: "load" });
      // Hydrated: the provider fetched the session and both consumers re-rendered.
      await pollFor(page, `${text("client")} === "CLIENT:unauthenticated:-"`);
      await pollFor(page, `${text("badge")} === "BADGE:unauthenticated"`);
      await (await page.$("#sign-in"))!.click();
      await pollFor(page, `${text("client")} === "CLIENT:authenticated:Ada"`);
      await pollFor(page, `${text("badge")} === "BADGE:authenticated"`);
      await (await page.$("#sign-out"))!.click();
      await pollFor(page, `${text("client")} === "CLIENT:unauthenticated:-"`);
      assertNoConsoleErrors(errors);
      await page.close();
    } finally {
      await server.close();
    }
  } finally {
    await browser.close();
    await stopNextCompat();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
