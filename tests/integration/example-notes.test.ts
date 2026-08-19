// examples/notes end-to-end through the JavaScript-DISABLED path. This proves the
// whole app — cookie-session auth, the middleware gate, SQLite CRUD, ISR, notFound
// and the error boundary — works with no client runtime at all: every request is a
// plain fetch/form-post via `createTestApp` (in-process, no build) + a cookie-aware
// `createTestClient`. If hydration were required for any flow, this test would fail.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createTestApp, createTestClient } from "denext/testing";

// An ephemeral database and a fixed secret — set before the app loads any module.
Deno.env.set("NOTES_DB", ":memory:");
Deno.env.set("SESSION_SECRET", "notes-example-test-secret");

const APP = new URL("../../examples/notes", import.meta.url).pathname;

// Seeded (deterministic order): note 1 = demo "Welcome" (public), 2 = demo private,
// 3 = alice "Alice says hi" (public). Used for the authz + not-found cases.
const ALICE_NOTE_ID = 3;

Deno.test("examples/notes: full app works with JavaScript disabled", async (t) => {
  const client = createTestClient(await createTestApp(APP));

  await t.step("home feed shows public notes but not private ones", async () => {
    const res = await client.get("/");
    assertEquals(res.status, 200);
    assertStringIncludes(res.text, "Welcome to denext notes"); // demo, public
    assertStringIncludes(res.text, "Alice says hi"); // alice, public
    assert(!res.text.includes("A private thought"), "a private note must not leak to the feed");
  });

  await t.step("middleware gates /notes when signed out", async () => {
    const res = await client.get("/notes");
    assertEquals(res.status, 307);
    assertStringIncludes(res.location ?? "", "/login");
  });

  await t.step("bad credentials are rejected", async () => {
    const guest = createTestClient(await createTestApp(APP));
    const page = await guest.get("/login");
    const res = await guest.submit(guest.form(page.text), { password: "wrong" });
    assertEquals(res.status, 303);
    assertStringIncludes(res.location ?? "", "error=1");
    // No session cookie was set.
    assertEquals(guest.cookies.get("denext_session"), undefined);
  });

  await t.step("sign in through the rendered form (no JS)", async () => {
    const page = await client.get("/login");
    const res = await client.submit(client.form(page.text)); // defaults = demo creds
    assertEquals(res.status, 303);
    assertStringIncludes(res.location ?? "", "/notes");
    assert(client.cookies.get("denext_session"), "a signed session cookie is now set");
  });

  await t.step("the gate now lets the signed-in user through", async () => {
    const res = await client.get("/notes");
    assertEquals(res.status, 200);
    assertStringIncludes(res.text, "My notes");
    assertStringIncludes(res.text, "A private thought"); // demo sees their own private note
    assert(!res.text.includes("Alice says hi"), "another user's notes must not appear");
  });

  await t.step("create a note via the form, then see it listed", async () => {
    const page = await client.get("/notes");
    const form = client.form(page.text, { has: "title" });
    const res = await client.submit(form, {
      title: "Groceries",
      body: "milk, eggs, bread",
      visibility: "public",
    });
    assertEquals(res.status, 303);

    const after = await client.get("/notes");
    assertStringIncludes(after.text, "Groceries");
    // It was public → it also appears on the home feed.
    const home = await client.get("/");
    assertStringIncludes(home.text, "Groceries");
  });

  await t.step("editing a note you don't own hits the error boundary", async () => {
    // A caught nested error boundary renders its fallback with a 200 (App Router
    // semantics) — the error surfaces through the UI, not the status code.
    const res = await client.get(`/notes/${ALICE_NOTE_ID}/edit`);
    assertEquals(res.status, 200);
    assertStringIncludes(res.text, "Something went wrong");
    // Production redacts the thrown error (Next parity): the raw message never
    // reaches the client — a generic message + an opaque digest do instead.
    assertStringIncludes(res.text, "Internal Server Error");
    assertStringIncludes(res.text, "Reference:");
    assert(!res.text.includes("permission"), "the raw error message must not leak to the client");
    assert(!res.text.includes("Alice says hi"), "the note content must not render past the error");
  });

  await t.step("a missing note renders not-found (404)", async () => {
    const res = await client.get("/notes/9999/edit");
    assertEquals(res.status, 404);
    assertStringIncludes(res.text, "Not found");
  });

  await t.step("sign out, and the gate closes again", async () => {
    const page = await client.get("/notes");
    // The sign-out form lives in the layout; it's the first action form on the page.
    const res = await client.submit(client.form(page.text, { action: /\/_denext\/action\// }));
    assertEquals(res.status, 303);
    assertEquals(client.cookies.get("denext_session"), undefined);

    const gated = await client.get("/notes");
    assertEquals(gated.status, 307);
    assertStringIncludes(gated.location ?? "", "/login");
  });
});
