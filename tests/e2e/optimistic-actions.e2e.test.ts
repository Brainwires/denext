// Real-browser e2e for the React 19 form hooks over a Server Action (examples/actions):
//   • useOptimistic shows the just-submitted row IMMEDIATELY (marked pending) — before the
//     server round-trip finishes — then reconciles it to the entry the server saved; and
//   • useFormStatus disables the submit button and shows "Signing…" while the action is in
//     flight; the whole exchange happens with no full page reload.
//
// The action round-trip is throttled via CDP (`emulateNetwork`) so the transient optimistic/
// pending window is reliably observable — a fast localhost round-trip blows past it. This is
// what regression-guards the useActionState → startTransition async-transition fix that keeps
// the optimistic overlay from reverting before it paints.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert } from "@std/assert";
import { buildAndServe, emulateNetwork, launchBrowser, pollFor } from "./harness.ts";

const EXAMPLE = new URL("../../examples/actions", import.meta.url).pathname;

Deno.test({
  name: "e2e: examples/actions shows an optimistic row + pending button, then reconciles",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(EXAMPLE);
  const browser = await launchBrowser();
  const page = await browser.newPage(server.origin + "/");
  const msg = `optimistic-${Date.now()}`;

  try {
    await page.waitForFunction("!!document.querySelector('.live form')");
    await page.evaluate("window.__noReload = true"); // a full reload would clear this
    // Add latency so the optimistic overlay and the pending button are observable.
    await emulateNetwork(page, { latencyMs: 500 });
    await page.evaluate(
      `(() => {
        const f = document.querySelector('.live form');
        f.querySelector('input[name=name]').value = 'Ada';
        f.querySelector('input[name=message]').value = ${JSON.stringify(msg)};
      })()`,
    );
    const submit = await page.$(".live form button[type=submit]");
    assert(submit, "the submit button exists");
    await submit.click();

    await t.step("the optimistic (pending) row shows before the server confirms", async () => {
      await pollFor(
        page,
        `!!Array.from(document.querySelectorAll('.entries li.pending')).find((li) => li.textContent.includes(${
          JSON.stringify(msg)
        }))`,
      );
      // useFormStatus: the button is disabled + labelled "Signing…" while the action runs.
      assert(
        await page.evaluate(
          "/Signing/.test(document.querySelector('.live form button').textContent)",
        ),
        "the submit button shows the pending label",
      );
    });

    await t.step("the row reconciles to the committed entry, with no reload", async () => {
      await pollFor(
        page,
        `!!Array.from(document.querySelectorAll('.entries li:not(.pending)')).find((li) => li.textContent.includes(${
          JSON.stringify(msg)
        }))`,
      );
      // No optimistic (pending) row lingers once the server entry is committed.
      assert(
        await page.evaluate("document.querySelectorAll('.entries li.pending').length === 0"),
        "the optimistic overlay cleared after reconciliation",
      );
      assert(await page.evaluate("window.__noReload === true"), "the action did not full-reload");
    });
  } finally {
    await page.close();
    await browser.close();
    await server.close();
  }
});
