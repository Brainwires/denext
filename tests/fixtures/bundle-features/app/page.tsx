// An isomorphic (route-entry) page: it calls hooks itself, so the whole route is one client tree.
// It uses a function-valued form action, a class component, `<Activity>`, `<ViewTransition>`,
// MVU, a `client:visible` island and every split-out hook (hooks.tsx).

import { Activity, useState, ViewTransition } from "denext";
import { Component } from "react";
import { useMvu } from "denext/mvu";
import { Counter } from "./counter.tsx";
import { Hooks } from "./hooks.tsx";

class Clock extends Component<{ label: string }> {
  override render() {
    return <p>{this.props.label}</p>;
  }
}

export default function Home() {
  const [saved, setSaved] = useState("");
  const [model, send] = useMvu(
    () => [{ n: 0 }],
    (msg: "inc", m: { n: number }) => [msg === "inc" ? { n: m.n + 1 } : m],
  );
  return (
    <section>
      <form action={(data: FormData) => setSaved(String(data.get("q") ?? ""))}>
        <input name="q" />
        <button type="submit">save {saved}</button>
      </form>
      <button type="button" onClick={() => send("inc")}>{model.n}</button>
      <Clock label="class" />
      <Activity mode="visible">
        <ViewTransition>
          <p>shown</p>
        </ViewTransition>
      </Activity>
      <Counter client:visible />
      <Hooks />
    </section>
  );
}
