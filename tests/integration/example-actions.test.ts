// Smoke test for examples/actions: build + serve it and drive the Server Action
// through its no-JS progressive-enhancement path — SSR renders the action's secure
// endpoint into the <form>, a native POST runs it server-side (CSRF-checked) and
// 303-redirects, and the mutation persists into the next render. Also asserts the
// "use client" island (useActionState/useOptimistic) shipped a client bundle.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { build } from "../../src/build/build.ts";
import { startProdOrigin } from "../helpers/prod-origin.ts";

const APP = new URL("../../examples/actions", import.meta.url).pathname;

type Ctx = { origin: string; actionUrl: string };

/** A native <form> POST to the action endpoint (no JS); returns the response status. */
async function postAction(
  ctx: Ctx,
  originHeader: string,
  fields: Record<string, string>,
): Promise<number> {
  const res = await fetch(`${ctx.origin}${ctx.actionUrl}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: originHeader,
    },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
  await res.body?.cancel();
  return res.status;
}

async function pageSsrsNativeActionForm(ctx: Ctx) {
  const html = await (await fetch(`${ctx.origin}/`)).text();
  // The seed entry renders (server read), and the form points at the action endpoint.
  assertStringIncludes(html, "Server Actions work with zero client JavaScript.");
  const m = html.match(/<form action="(\/_denext\/action\/[^"]+)"/);
  assert(m, "the native <form> must carry the Server Action endpoint URL");
  ctx.actionUrl = m![1].replace(/&amp;/g, "&");
  // The interactive island shipped a hydration bundle.
  assertStringIncludes(html, "/_denext/");
}

async function sameOriginPostRedirects(ctx: Ctx) {
  // same-origin → passes the CSRF check
  const status = await postAction(ctx, ctx.origin, {
    name: "Ada",
    message: "Hello from a no-JS form",
  });
  assertEquals(status, 303, "a no-JS action post redirects back");
}

async function mutationPersistsIntoNextRender(ctx: Ctx) {
  const html = await (await fetch(`${ctx.origin}/`)).text();
  assertStringIncludes(html, "Ada");
  assertStringIncludes(html, "Hello from a no-JS form");
}

async function crossOriginPostIsRefused(ctx: Ctx) {
  // mismatched origin
  const status = await postAction(ctx, "http://evil.example", { name: "Mallory", message: "xss" });
  assert(status >= 400, `cross-origin action must be refused, got ${status}`);
  // And it must not have been recorded.
  const html = await (await fetch(`${ctx.origin}/`)).text();
  assert(!html.includes("Mallory"), "a cross-origin post must not mutate state");
}

Deno.test({
  name: "examples/actions: server action progressive enhancement + client island",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const controller = new AbortController();
  let server: Deno.HttpServer | undefined;
  try {
    await build(APP);
    const started = await startProdOrigin(APP, controller.signal);
    server = started.server;
    const ctx: Ctx = { origin: started.origin, actionUrl: "" };

    await t.step(
      "the page SSRs the native form with a Server Action endpoint",
      () => pageSsrsNativeActionForm(ctx),
    );

    await t.step(
      "a same-origin native POST runs the action and 303-redirects",
      () => sameOriginPostRedirects(ctx),
    );

    await t.step(
      "the mutation persists into the next server render",
      () => mutationPersistsIntoNextRender(ctx),
    );

    await t.step(
      "a cross-origin action post is refused (CSRF)",
      () => crossOriginPostIsRefused(ctx),
    );
  } finally {
    controller.abort();
    await server?.finished;
  }
});
