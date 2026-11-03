// Real-browser e2e: a next-compat app on Auth.js v5 with `next-auth/providers/passkey`, unchanged,
// in headless Chromium with a CDP WebAuthn virtual authenticator (`WebAuthn.addVirtualAuthenticator`:
// CTAP2, internal, resident keys, user verification). The user signs in with a password, registers
// a passkey through `next-auth/webauthn`'s `signIn("passkey", { action: "register" })`, signs out,
// and signs back in with the passkey alone; the authenticator holds one discoverable credential
// whose counter moved.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals } from "@std/assert";
import { build } from "../../src/build/build.ts";
import { stopNextCompat } from "../../src/build/next-compat.ts";
import { startProdServer } from "../../src/build/prod-server.ts";
import { writeNextAuthPasskeyFixture } from "../helpers/next-auth-passkey-fixture.ts";
import { onFreePort } from "../helpers/port.ts";
import { assertNoConsoleErrors, collectConsoleErrors, launchBrowser, pollFor } from "./harness.ts";

/** The text of `#id`, as a page expression. */
const text = (id: string) => `document.getElementById(${JSON.stringify(id)})?.textContent`;

Deno.test({
  name: "e2e: next-auth's Passkey provider registers and signs in on denext's passkeys",
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_nextauth_passkey_e2e_" });
  await writeNextAuthPasskeyFixture(dir);
  const previous = Deno.env.get("AUTH_URL");
  const controller = new AbortController();
  const browser = await launchBrowser();
  try {
    // The relying party is AUTH_URL's origin (WebAuthn needs `localhost` and the exact port), and
    // denext never takes it from the Host header: the port is known before the server starts, so
    // it is picked, and a start that loses the port to another process runs again on a fresh one.
    let origin = "";
    const server = await onFreePort(async (port) => {
      origin = `http://localhost:${port}`;
      Deno.env.set("AUTH_URL", `${origin}/api/auth`);
      await build(dir);
      const listening = Promise.withResolvers<void>();
      const started = await startProdServer({
        projectDir: dir,
        port,
        hostname: "127.0.0.1",
        signal: controller.signal,
        onListen: () => listening.resolve(),
      });
      await listening.promise;
      return started;
    });
    try {
      const page = await browser.newPage();
      const errors = collectConsoleErrors(page);
      // deno-lint-ignore no-explicit-any
      const cdp = page.unsafelyGetCelestialBindings() as any;
      await cdp.WebAuthn.enable({ enableUI: false });
      const { authenticatorId } = await cdp.WebAuthn.addVirtualAuthenticator({
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      await page.goto(`${origin}/`, { waitUntil: "load" });
      await pollFor(page, `${text("client")} === "CLIENT:unauthenticated:-"`);
      // A password sign-in, then a passkey for the signed-in user.
      await (await page.$("#sign-in"))!.click();
      await pollFor(page, `${text("client")} === "CLIENT:authenticated:Ada"`);
      await (await page.$("#register"))!.click();
      await pollFor(page, `${text("result")} === "register:ok"`);
      const registered = await cdp.WebAuthn.getCredentials({ authenticatorId });
      assertEquals(registered.credentials.length, 1);
      assert(registered.credentials[0].isResidentCredential, "a discoverable credential");
      // Signed out, then back in with the passkey alone.
      await (await page.$("#sign-out"))!.click();
      await pollFor(page, `${text("client")} === "CLIENT:unauthenticated:-"`);
      await (await page.$("#passkey"))!.click();
      await pollFor(page, `${text("result")} === "passkey:ok"`);
      await pollFor(page, `${text("client")} === "CLIENT:authenticated:Ada"`);
      const used = await cdp.WebAuthn.getCredentials({ authenticatorId });
      assert(used.credentials[0].signCount > registered.credentials[0].signCount, "counter moved");
      assertNoConsoleErrors(errors);
      await page.close();
    } finally {
      controller.abort();
      await server.finished;
    }
  } finally {
    if (previous === undefined) Deno.env.delete("AUTH_URL");
    else Deno.env.set("AUTH_URL", previous);
    await browser.close();
    await stopNextCompat();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
