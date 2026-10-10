// The markup the shell and the app share, so the app replaces the shell with no layout shift.
import type { VNodeChildren } from "denext";

export function Layout(
  props: { title: string; marker: string; children?: VNodeChildren },
) {
  return (
    <main className="layout" data-marker={props.marker}>
      <header className="bar">{props.title}</header>
      {props.children}
    </main>
  );
}
