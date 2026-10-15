// `denext/mvu` — the Model–View–Update engine (effects as data, keyed subscriptions) and the
// `useMvu` / `MvuView` hooks, plus the dev time-travel record the DevTools MVU tab reads.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import {
  createMvuEngine,
  defineMvu,
  type Effect,
  eventPayload,
  fx,
  type MvuHost,
  type Next,
  resolveMsg,
  subs,
  type Subscription,
} from "../src/runtime/mvu.ts";
import { MvuView, useMvu } from "../src/mvu.ts";
import { act, render } from "../src/testing/mod.ts";

type Msg =
  | { type: "inc" }
  | { type: "add"; by: number }
  | { type: "got"; data: unknown }
  | { type: "failed"; error: unknown }
  | { type: "tick" };

interface Model {
  n: number;
  log: string[];
}

/** A promise resolved with the model after the next processed batch matching `when`. */
function changes<M>(): {
  onChange: (model: M, msgs: readonly unknown[]) => void;
  next: (when?: (model: M) => boolean) => Promise<M>;
} {
  const waiters: Array<{ when: (m: M) => boolean; resolve: (m: M) => void }> = [];
  return {
    onChange(model) {
      for (const w of [...waiters]) {
        if (w.when(model)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(model);
        }
      }
    },
    next: (when = () => true) => new Promise((resolve) => waiters.push({ when, resolve })),
  };
}

function update(msg: Msg, m: Model): Next<Model, Msg> {
  switch (msg.type) {
    case "inc":
      return [{ ...m, n: m.n + 1 }];
    case "add":
      return [{ ...m, n: m.n + msg.by }];
    case "got":
      return [{ ...m, log: [...m.log, `got:${JSON.stringify(msg.data)}`] }];
    case "failed":
      return [{ ...m, log: [...m.log, `failed:${JSON.stringify(msg.error)}`] }];
    case "tick":
      return [{ ...m, n: m.n + 1 }];
  }
}

Deno.test("mvu engine: messages update the model in order and a batch notifies once", () => {
  const seen: Array<[number, number]> = [];
  const engine = createMvuEngine<Model, Msg>({
    init: [{ n: 0, log: [] }],
    update: () => (msg, m) => {
      if (msg.type === "inc" && m.n === 0) {
        // A dispatch from inside update is queued behind the current message.
        engine.dispatch({ type: "add", by: 10 });
      }
      return update(msg, m);
    },
    onChange: (model, msgs) => seen.push([model.n, msgs.length]),
  });
  engine.dispatch({ type: "inc" }); // not started: ignored
  assertEquals(engine.model.n, 0);
  engine.start();
  engine.dispatch({ type: "inc" });
  assertEquals(engine.model.n, 11);
  assertEquals(seen, [[11, 2]]);
  engine.stop();
});

Deno.test("mvu engine: a throwing update drops the message and keeps the model", () => {
  const errors: unknown[] = [];
  const engine = createMvuEngine<Model, Msg>({
    init: [{ n: 1, log: [] }],
    update: () => (msg, m) => {
      if (msg.type === "tick") throw new Error("boom");
      return update(msg, m);
    },
    onUpdateError: (err) => errors.push((err as Error).message),
  });
  engine.start();
  engine.dispatch({ type: "tick" });
  engine.dispatch({ type: "inc" });
  assertEquals(engine.model.n, 2);
  assertEquals(errors, ["boom"]);
  engine.stop();
});

Deno.test("mvu engine: effects run after the update — dispatch, task ok/err, delay", async () => {
  const c = changes<Model>();
  const engine = createMvuEngine<Model, Msg>({
    init: [{ n: 0, log: [] }, [fx.dispatch<Msg>({ type: "add", by: 5 })]],
    update: () => (msg, m) => {
      if (msg.type === "inc") {
        return [{ ...m, n: m.n + 1 }, [
          fx.task(() => Promise.resolve(7), (v) => ({ type: "got", data: v })),
          fx.task(
            () => Promise.reject(new Error("nope")),
            undefined,
            (e) => ({ type: "failed", error: (e as Error).message }),
          ),
          fx.delay<Msg>(1, { type: "add", by: 100 }),
        ]];
      }
      return update(msg, m);
    },
    onChange: c.onChange,
  });
  const added = c.next((m) => m.n === 5);
  engine.start(); // the init effects run on start
  assertEquals((await added).n, 5);
  const settled = c.next((m) => m.log.length === 2 && m.n >= 106);
  engine.dispatch({ type: "inc" });
  const m = await settled;
  assertEquals(m.n, 106);
  assertEquals([...m.log].sort(), ['failed:"nope"', "got:7"]);
  engine.stop();
});

Deno.test("mvu engine: stop cancels a pending delay and aborts a running task", async () => {
  let aborted = false;
  const started = Promise.withResolvers<void>();
  const engine = createMvuEngine<Model, Msg>({
    init: [{ n: 0, log: [] }, [
      fx.delay<Msg>(60_000, { type: "inc" }),
      fx.task<Msg>((signal) =>
        new Promise((_, reject) => {
          started.resolve();
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(signal.reason);
          });
        })
      ),
    ]],
    update: () => update,
    host: { onError: () => {} },
  });
  engine.start();
  await started.promise;
  engine.stop(); // clears the 60 s timer (the test sanitizer would flag a leak) and aborts
  assert(aborted);
  assertEquals(engine.model.n, 0);
});

Deno.test("mvu engine: fetch effect maps a 2xx body to ok and any other status to err", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const path = new URL(req.url).pathname;
    return path === "/ok" ? Response.json({ hello: "world" }) : new Response("no", { status: 418 });
  });
  const base = `http://localhost:${(server.addr as Deno.NetAddr).port}`;
  try {
    const c = changes<Model>();
    const engine = createMvuEngine<Model, Msg>({
      init: [{ n: 0, log: [] }, [
        fx.fetch<Msg>(`${base}/ok`, { ok: (data) => ({ type: "got", data }) }),
        fx.fetch<Msg>(`${base}/teapot`, {
          ok: (data) => ({ type: "got", data }),
          err: (error) => ({ type: "failed", error }),
        }),
      ]],
      update: () => update,
      onChange: c.onChange,
    });
    const done = c.next((m) => m.log.length === 2);
    engine.start();
    const m = await done;
    assertEquals([...m.log].sort(), ['failed:{"status":418}', 'got:{"hello":"world"}']);
    engine.stop();
  } finally {
    await server.shutdown();
  }
});

Deno.test("mvu engine: subscriptions follow the model — kept by key, started and stopped", () => {
  const opened: string[] = [];
  const closed: string[] = [];
  let push: ((payload: unknown) => void) | null = null;
  const host: MvuHost = {
    channel(id, key, onPayload) {
      opened.push(`${id}/${key}`);
      push = onPayload;
      return () => closed.push(`${id}/${key}`);
    },
  };
  interface M {
    room: string | null;
    got: unknown[];
  }
  type G = { type: "join"; room: string | null } | { type: "msg"; payload: unknown };
  const engine = createMvuEngine<M, G>({
    init: [{ room: "a", got: [] }],
    update: () => (msg, m) =>
      msg.type === "join" ? [{ ...m, room: msg.room }] : [{ ...m, got: [...m.got, msg.payload] }],
    subscriptions: () => (m) => [
      m.room !== null &&
      subs.channel({ denextChannelId: "chat" }, m.room, (p) => ({ type: "msg", payload: p })),
    ],
    host,
  });
  engine.start();
  assertEquals(opened, ["chat/a"]);
  push!({ text: "hi" });
  assertEquals(engine.model.got, [{ text: "hi" }]);
  // The same key on a model change keeps the subscription (no re-open).
  engine.dispatch({ type: "msg", payload: 2 });
  assertEquals(opened, ["chat/a"]);
  engine.dispatch({ type: "join", room: "b" });
  assertEquals(opened, ["chat/a", "chat/b"]);
  assertEquals(closed, ["chat/a"]);
  engine.dispatch({ type: "join", room: null });
  assertEquals(closed, ["chat/a", "chat/b"]);
  engine.stop();
});

Deno.test("mvu engine: an interval subscription ticks until the model drops it", async () => {
  const c = changes<{ on: boolean; ticks: number }>();
  type T = { type: "tick" } | { type: "off" };
  const engine = createMvuEngine<{ on: boolean; ticks: number }, T>({
    init: [{ on: true, ticks: 0 }],
    update: () => (msg, m) =>
      msg.type === "tick" ? [{ ...m, ticks: m.ticks + 1 }] : [{ ...m, on: false }],
    subscriptions: () => (m) => [m.on && subs.interval<T>(1, { type: "tick" })],
    onChange: c.onChange,
  });
  engine.start();
  await c.next((m) => m.ticks >= 3);
  engine.dispatch({ type: "off" }); // stops the interval (the sanitizer would flag a leak)
  const ticks = engine.model.ticks;
  engine.stop();
  assert(ticks >= 3);
});

Deno.test("mvu engine: host caps refuse effects and subscriptions past the limit", () => {
  const errors: string[] = [];
  const host: MvuHost = {
    maxPending: 1,
    maxSubscriptions: 1,
    onError: (e) => errors.push((e as Error).message),
  };
  const never = () => new Promise<never>(() => {});
  const engine = createMvuEngine<Model, Msg>({
    init: [{ n: 0, log: [] }, [
      fx.task<Msg>(never),
      fx.task<Msg>(never, undefined, (e) => ({ type: "failed", error: (e as Error).message })),
    ]],
    update: () => update,
    subscriptions: () => () => [
      subs.interval<Msg>(60_000, { type: "tick" }, "a"),
      subs.interval<Msg>(60_000, { type: "tick" }, "b"),
    ],
    host,
  });
  engine.start();
  assertEquals(errors, ["too many subscriptions"]);
  assertEquals(engine.model.log, ['failed:"too many pending effects"']);
  engine.stop();
});

Deno.test("mvu engine: an unknown effect kind is reported, not thrown", () => {
  const errors: string[] = [];
  const engine = createMvuEngine<Model, Msg>({
    init: [{ n: 0, log: [] }, [{ kind: "launch" } as unknown as Effect<Msg>]],
    update: () => update,
    host: { onError: (e) => errors.push((e as Error).message) },
  });
  engine.start();
  assertEquals(errors, ['unknown effect "launch"']);
  engine.stop();
});

Deno.test("mvu: fx / subs build plain data and resolveMsg reads the event payload", () => {
  assertEquals(fx.delay(5, { type: "inc" }), { kind: "delay", ms: 5, msg: { type: "inc" } });
  assertEquals(subs.interval(10, "t"), { kind: "interval", ms: 10, msg: "t" });
  const s: Subscription<string> = subs.channel({ denextChannelId: "c" }, "k", String);
  assertEquals(s.kind, "channel");
  assertEquals(resolveMsg({ type: "inc" }, {}), { type: "inc" });
  assertEquals(resolveMsg((p) => (p.value ? { text: p.value } : null), { value: "x" }), {
    text: "x",
  });
  assertEquals(resolveMsg(() => undefined, {}), null);
  assertEquals(
    eventPayload({ type: "input", target: { tagName: "INPUT", value: "hi", type: "text" } }),
    { value: "hi" },
  );
  assertEquals(
    eventPayload({
      type: "change",
      target: { tagName: "INPUT", value: "on", type: "checkbox", checked: true },
    }),
    { value: "on", checked: true },
  );
  assertEquals(eventPayload({ type: "keydown", key: "Enter", target: null }), { key: "Enter" });
  // A button's (empty) value is not a payload: only form controls carry one.
  assertEquals(eventPayload({ type: "click", target: { tagName: "BUTTON", value: "" } }), {});
  let prevented = false;
  assertEquals(
    eventPayload({ type: "submit", target: null, preventDefault: () => (prevented = true) }),
    {},
  );
  assert(prevented, "a bound submit never navigates");
  assertEquals(eventPayload(null), {});
});

const counter = defineMvu<{ n: number }, { type: "inc" } | { type: "set"; to: string }, {
  start: number;
}>({
  init: (props) => [{ n: props.start }],
  update: (msg, m) => msg.type === "inc" ? [{ n: m.n + 1 }] : [{ n: Number(msg.to) || 0 }],
  view: (m, send) =>
    h(
      "div",
      null,
      h("button", { type: "button", onClick: send({ type: "inc" }) }, `n=${m.n}`),
      h("input", { placeholder: "n", onInput: send((p) => ({ type: "set", to: p.value ?? "" })) }),
    ),
});

Deno.test("MvuView: renders the init model on the server and runs the program in the browser", async () => {
  const html = await renderToString(h(MvuView as never, { program: counter, props: { start: 3 } }));
  assert(html.includes("n=3"), html);
  assert(!html.includes("onclick"), "no handler attribute in the server HTML");

  const screen = await render(h(MvuView as never, { program: counter, props: { start: 1 } }));
  await screen.fireEvent.click(screen.getByRole("button"));
  assertEquals(screen.getByRole("button").textContent, "n=2");
  await screen.fireEvent.input(screen.getByPlaceholderText("n"), {
    target: { value: "40" },
  });
  assertEquals(screen.getByRole("button").textContent, "n=40");
  await screen.unmount();
});

Deno.test("useMvu: effects start on mount and stop on unmount; dev records steps for time travel", async () => {
  const g = globalThis as { __denextDev?: boolean; __denextMvu?: Map<number, unknown> };
  const prevDev = g.__denextDev;
  g.__denextDev = true;
  const ran: string[] = [];
  let dispatchRef: ((m: Msg) => void) | null = null;
  function Comp() {
    const [model, dispatch] = useMvu<Model, Msg>(
      () => [{ n: 0, log: [] }, [fx.task(() => ran.push("init"))]],
      update,
      undefined,
      { name: "Comp" },
    );
    dispatchRef = dispatch;
    return h("p", null, `n=${model.n}`);
  }
  try {
    const screen = await render(h(Comp, null));
    assertEquals(ran, ["init"]);
    await act(() => dispatchRef!({ type: "inc" }));
    await act(() => dispatchRef!({ type: "add", by: 5 }));
    assertEquals(screen.container.textContent, "n=6");
    const rec = [...g.__denextMvu!.values()].find((r) =>
      (r as { name: string }).name === "Comp"
    ) as {
      steps: Array<{ msg: unknown; model: Model }>;
      cursor: number;
      jump(i: number): void;
    };
    assertEquals(rec.steps.map((s) => s.model.n), [0, 1, 6]);
    await act(() => rec.jump(1)); // travel back to after the first message
    assertEquals(screen.container.textContent, "n=1");
    // A new message continues from the step on screen; the undone future is dropped.
    await act(() => dispatchRef!({ type: "inc" }));
    assertEquals(rec.steps.map((s) => s.model.n), [0, 1, 2]);
    assertEquals(screen.container.textContent, "n=2");
    await screen.unmount();
    assert(
      ![...g.__denextMvu!.values()].some((r) => (r as { name: string }).name === "Comp"),
      "an unmounted program leaves the registry",
    );
  } finally {
    g.__denextDev = prevDev;
  }
});
