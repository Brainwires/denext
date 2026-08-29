// useAsyncEffect: the abort-aware helpers injected into the effect
// (`sleep`/`setTimeout`/`fetch`) and the hook's error handling.
//
// Focus of these tests is the cancellation contract corrected in the 2026-08-29
// review pass: the timer helpers REJECT (not resolve) once the effect's signal
// aborts, so the effect body stops at the next `await`; the hook swallows those
// aborts (from its own controller and from a caller-supplied `init.signal`)
// instead of surfacing them as fatal render errors.

import { assert, assertEquals } from "@std/assert";
import { useAsyncEffect } from "denext";
import { h } from "denext/jsx-runtime";
import { render } from "denext/testing";

/** A promise plus its resolver, so a test can await an effect reaching a point. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

Deno.test("setTimeout helper runs its task and resolves when not aborted", async () => {
  const ran = deferred();
  let after = false;

  function Comp() {
    useAsyncEffect(async ({ setTimeout }) => {
      await setTimeout(1, () => ran.resolve());
      after = true;
    }, []);
    return h("p", null, "ok");
  }

  const screen = await render(h(Comp, null));
  await ran.promise;
  // let the microtask after the await flush
  await new Promise((r) => setTimeout(r, 5));
  assert(after, "code after `await setTimeout` should run on the happy path");
  await screen.unmount();
});

Deno.test("unmount aborts an in-flight sleep: the continuation never runs", async () => {
  let reachedSleep = false;
  let afterSleep = false;
  const reached = deferred();

  function Comp() {
    useAsyncEffect(async ({ sleep }) => {
      reachedSleep = true;
      reached.resolve();
      await sleep(10_000); // long enough that only the abort settles it
      afterSleep = true; // must NOT run — effect was cleaned up
    }, []);
    return h("p", null, "ok");
  }

  const screen = await render(h(Comp, null));
  await reached.promise;
  assert(reachedSleep, "effect body should have started");

  await screen.unmount(); // aborts the controller -> sleep rejects
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(afterSleep, false, "continuation after an aborted sleep must not run");
});

Deno.test("an aborted timer is a cancellation, not a fatal render error", async () => {
  // If the abort rejection leaked past the hook it would be re-thrown during
  // render and surface here as an unhandled error / broken tree.
  function Comp() {
    useAsyncEffect(async ({ sleep }) => {
      await sleep(10_000);
    }, []);
    return h("p", null, "alive");
  }

  const screen = await render(h(Comp, null));
  assertEquals(screen.getByText("alive").tagName, "P");
  await screen.unmount();
  // Give any leaked rejection a tick to blow up; reaching here means it didn't.
  await new Promise((r) => setTimeout(r, 5));
});

Deno.test("a non-abort rejection is routed to catch/onError", async () => {
  const seen = deferred<string>();

  class DomainError extends Error {}

  function Comp() {
    useAsyncEffect(() => Promise.reject(new DomainError("boom")), {
      catch: [DomainError],
      onError: (err) => seen.resolve(err.message),
    }, []);
    return h("p", null, "ok");
  }

  const screen = await render(h(Comp, null));
  assertEquals(await seen.promise, "boom");
  await screen.unmount();
});

Deno.test("an AbortError from any source is swallowed, not fatal", async () => {
  // A caller-supplied `init.signal` abort makes fetch reject with a DOMException
  // AbortError while the effect's own controller is NOT aborted. That must be
  // treated as a cancellation, not thrown as a fatal render error. Throwing the
  // same error directly exercises the exact guard without racing fetch timing.
  function Comp() {
    useAsyncEffect(
      () => Promise.reject(new DOMException("The operation was aborted.", "AbortError")),
      [],
    );
    return h("p", null, "alive");
  }

  const screen = await render(h(Comp, null));
  await new Promise((r) => setTimeout(r, 5));
  // Reaching here (tree still alive) proves the AbortError did not become fatal.
  assertEquals(screen.getByText("alive").tagName, "P");
  await screen.unmount();
});

Deno.test("fetch helper type accepts a URL input", async () => {
  // Compile-time coverage for the `RequestInfo | URL` widening: this file would
  // fail `deno check` if the helper still rejected `URL`.
  function Comp() {
    useAsyncEffect(async ({ fetch, signal }) => {
      if (signal.aborted) return;
      const url = new URL("data:,hello");
      await fetch(url).catch(() => {});
    }, []);
    return h("p", null, "ok");
  }
  const screen = await render(h(Comp, null));
  await screen.unmount();
});
