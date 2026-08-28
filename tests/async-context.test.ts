import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import {
  __asyncAwait,
  __asyncScope,
  __asyncScopeEnd,
  AsyncContext,
  Snapshot,
  Variable,
} from "../src/runtime/async-context.ts";

Deno.test("Variable: get() is undefined outside any run()", () => {
  const v = new Variable<number>();
  assertEquals(v.get(), undefined);
});

Deno.test("Variable: run() binds the value for the synchronous scope, then restores", () => {
  const v = new Variable<string>();
  let inside: string | undefined;
  const ret = v.run("hello", () => {
    inside = v.get();
    return 42;
  });
  assertEquals(inside, "hello");
  assertEquals(ret, 42); // run returns the callback's result
  assertEquals(v.get(), undefined); // restored on exit
});

Deno.test("Variable: run() forwards extra args to the callback", () => {
  const v = new Variable<number>();
  const sum = v.run(1, (a: number, b: number) => a + b + (v.get() ?? 0), 10, 100);
  assertEquals(sum, 111);
});

Deno.test("Variable: nested run() shadows and restores the outer binding", () => {
  const v = new Variable<number>();
  const seen: (number | undefined)[] = [];
  v.run(1, () => {
    seen.push(v.get()); // 1
    v.run(2, () => {
      seen.push(v.get()); // 2
    });
    seen.push(v.get()); // 1 — inner restored
  });
  seen.push(v.get()); // undefined — outer restored
  assertEquals(seen, [1, 2, 1, undefined]);
});

Deno.test("Variable: the binding is restored even when the callback throws", () => {
  const v = new Variable<string>();
  assertThrows(() =>
    v.run("x", () => {
      throw new Error("boom");
    })
  );
  assertEquals(v.get(), undefined);
});

Deno.test("Variable: defaultValue is returned outside any run()", () => {
  const v = new Variable<string>({ name: "theme", defaultValue: "light" });
  assertEquals(v.name, "theme");
  assertEquals(v.get(), "light");
  v.run("dark", () => assertEquals(v.get(), "dark"));
  assertEquals(v.get(), "light"); // back to the default
});

Deno.test("Variable: two variables are independent", () => {
  const a = new Variable<string>();
  const b = new Variable<string>();
  a.run("A", () => {
    b.run("B", () => {
      assertEquals(a.get(), "A");
      assertEquals(b.get(), "B");
    });
    assertEquals(a.get(), "A");
    assertEquals(b.get(), undefined);
  });
});

Deno.test("Snapshot: captures the current context and re-enters it later", () => {
  const v = new Variable<string>();
  let snap: Snapshot | undefined;
  v.run("captured", () => {
    snap = new Snapshot();
  });
  // Outside the run, the value is gone...
  assertEquals(v.get(), undefined);
  // ...but the snapshot restores it for its callback.
  snap!.run(() => assertEquals(v.get(), "captured"));
  assertEquals(v.get(), undefined); // restored after
});

Deno.test("Snapshot: a run() after the snapshot does not leak into it (copy-on-write)", () => {
  const v = new Variable<number>();
  let snap: Snapshot | undefined;
  v.run(1, () => {
    snap = new Snapshot(); // captures v=1
  });
  v.run(2, () => {
    // Even while v=2 is live, the earlier snapshot still sees v=1.
    snap!.run(() => assertEquals(v.get(), 1));
    assertEquals(v.get(), 2);
  });
});

Deno.test("Snapshot.wrap: binds a function to the context current at wrap time", () => {
  const v = new Variable<string>();
  let wrapped: (() => string | undefined) | undefined;
  v.run("wrap-time", () => {
    wrapped = Snapshot.wrap(() => v.get());
  });
  // Called in a different context — still sees the wrap-time value.
  assertEquals(v.run("call-time", () => wrapped!()), "wrap-time");
});

Deno.test("AsyncContext namespace exposes Variable and Snapshot", () => {
  assertStrictEquals(AsyncContext.Variable, Variable);
  assertStrictEquals(AsyncContext.Snapshot, Snapshot);
});

// The following two tests exercise the scope helpers exactly as the build transform
// wires them, by hand-desugaring an instrumented async function:
//   async () => { const $=__asyncScope(); try { …await X→await __asyncAwait($,X)… }
//                 finally { __asyncScopeEnd($); } }

Deno.test("scope helpers: a frame's context survives an await (and an interloper)", async () => {
  const v = new Variable<string>();
  await v.run("frame", async () => {
    const $ = __asyncScope();
    try {
      assertEquals(v.get(), "frame");
      // Unrelated code runs in a different context while we're suspended.
      await __asyncAwait($, v.run("interloper", () => Promise.resolve("x")));
      // The frame's context is re-established on resume, despite the interloper.
      assertEquals(v.get(), "frame");
      await __asyncAwait($, Promise.resolve());
      assertEquals(v.get(), "frame");
    } finally {
      __asyncScopeEnd($);
    }
  });
  // Critical: no trailing leak — after the instrumented async fn settles, the
  // global context is clean, so an unrelated later read sees nothing.
  assertEquals(v.get(), undefined);
});

Deno.test("scope helpers: the frame context restores even when the awaited value rejects", async () => {
  const v = new Variable<string>();
  let observed: string | undefined = "unset";
  await v.run("frame", async () => {
    const $ = __asyncScope();
    try {
      await __asyncAwait($, Promise.reject(new Error("nope"))).catch(() => {});
      observed = v.get();
    } finally {
      __asyncScopeEnd($);
    }
  });
  assertEquals(observed, "frame"); // restored after the rejection
  assertEquals(v.get(), undefined); // no trailing leak
});

Deno.test("scope helpers: an urgent read between two async transitions is not polluted", async () => {
  // Models the transition-scheduler fix: after transition A's async work settles,
  // a synchronous read outside any transition must NOT see A's context.
  const tx = new Variable<string>();
  const runTransition = (id: string) =>
    tx.run(id, async () => {
      const $ = __asyncScope();
      try {
        await __asyncAwait($, Promise.resolve());
        assertEquals(tx.get(), id); // post-await, still scoped to this transition
      } finally {
        __asyncScopeEnd($);
      }
    });
  await runTransition("A");
  assertEquals(tx.get(), undefined); // urgent-path read: clean
  await runTransition("B");
  assertEquals(tx.get(), undefined);
});
