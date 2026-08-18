// Component-level testing via denext/testing's `render` — real hooks, effects, and
// events in an in-memory DOM (no browser).

import { assert, assertEquals } from "@std/assert";
import { useEffect, useState } from "denext";
import { h } from "denext/jsx-runtime";
import { fireEvent, render } from "denext/testing";

function Counter({ start = 0 }: { start?: number }) {
  const [n, setN] = useState(start);
  return h("button", { type: "button", onClick: () => setN(n + 1) }, `Count: ${n}`);
}

Deno.test("render + click drives useState and re-renders", async () => {
  const screen = await render(h(Counter, null));
  const btn = screen.getByRole("button");
  assertEquals(btn.textContent, "Count: 0");
  await screen.fireEvent.click(btn);
  assertEquals(screen.getByRole("button").textContent, "Count: 1");
  await fireEvent.click(screen.getByRole("button"));
  assertEquals(screen.getByRole("button").textContent, "Count: 2");
});

Deno.test("useEffect runs during render (wrapped in act)", async () => {
  function AfterMount() {
    const [msg, setMsg] = useState("loading");
    useEffect(() => {
      setMsg("ready");
    }, []);
    return h("p", null, msg);
  }
  const screen = await render(h(AfterMount, null));
  assertEquals(screen.getByText("ready").tagName, "P");
  assertEquals(screen.queryByText("loading"), null);
});

Deno.test("a controlled input updates via fireEvent.change", async () => {
  function Field() {
    const [v, setV] = useState("");
    return h(
      "div",
      null,
      h("label", { for: "name" }, "Name"),
      h("input", {
        id: "name",
        value: v,
        onChange: (e: { target: { value: string } }) => setV(e.target.value),
      }),
      h("p", { "data-testid": "echo" }, v),
    );
  }
  const screen = await render(h(Field, null));
  const input = screen.getByLabelText("Name");
  await screen.fireEvent.change(input, { target: { value: "Ada" } });
  assertEquals(screen.getByLabelText("Name").value, "Ada");
  assertEquals(screen.getByTestId("echo").textContent, "Ada");
});

Deno.test("queries: role/name, text, testid, placeholder", async () => {
  const screen = await render(
    h(
      "form",
      null,
      h("h1", null, "Sign in"),
      h("input", { placeholder: "you@example.com" }),
      h("button", { type: "submit" }, "Continue"),
    ),
  );
  assertEquals(screen.getByRole("heading").textContent, "Sign in");
  assertEquals(screen.getByRole("button", { name: "Continue" }).tagName, "BUTTON");
  assertEquals(screen.getByPlaceholderText("you@example.com").tagName, "INPUT");
  assertEquals(screen.getByText("Sign in").tagName, "H1");
});

Deno.test("unmount runs cleanup effects", async () => {
  const events: string[] = [];
  function WithCleanup() {
    useEffect(() => {
      events.push("mount");
      return () => events.push("cleanup");
    }, []);
    return h("span", null, "hi");
  }
  const screen = await render(h(WithCleanup, null));
  assertEquals(events, ["mount"]);
  await screen.unmount();
  assertEquals(events, ["mount", "cleanup"]);
});

Deno.test("rerender updates props", async () => {
  const Greeting = ({ name }: { name: string }) => h("p", null, `Hi ${name}`);
  const screen = await render(h(Greeting, { name: "Ada" }));
  assertEquals(screen.getByText("Hi Ada").tagName, "P");
  await screen.rerender(h(Greeting, { name: "Bob" }));
  assertEquals(screen.getByText("Hi Bob").tagName, "P");
  assertEquals(screen.queryByText("Hi Ada"), null);
});

Deno.test("getByText throws a helpful error when missing", async () => {
  const screen = await render(h("div", null, "hello"));
  let threw = false;
  try {
    screen.getByText("nope");
  } catch (e) {
    threw = true;
    assert((e as Error).message.includes("Unable to find"));
  }
  assert(threw, "getByText should throw when no match");
});
