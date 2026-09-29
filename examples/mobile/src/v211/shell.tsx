// The frame of every 2.11 demo screen: a back button, the title, what the tester should do,
// then the demo. `fill` gives the body the rest of the viewport (lists, chat, navigation).
import type { ReactNode } from "denext";
import { navigate } from "../ui.tsx";

export function Screen(
  { title, todo, fill, insetBottom = true, children }: {
    title: string;
    /** What the tester does, and what they should see. */
    todo: string;
    /** A full-height column: the head, then `children` (use `<Fill>` for the part that grows). */
    fill?: boolean;
    /** Keep a `fill` screen's content above the home indicator (default `true`). */
    insetBottom?: boolean;
    children?: ReactNode;
  },
) {
  return (
    <div class={fill ? "screen screen-fill" : "screen"}>
      <div class="screen-head">
        <button type="button" onClick={() => navigate("/")}>‹ Home</button>
        <strong>{title}</strong>
      </div>
      <p class="todo">{todo}</p>
      {fill
        ? <div class={insetBottom ? "screen-col inset-bottom" : "screen-col"}>{children}</div>
        : <div class="screen-body">{children}</div>}
    </div>
  );
}

/**
 * The part of a `fill` screen that takes the rest of the height, below whatever sits above
 * it (in the flow, so it can never overlap a header that wraps). Its child fills it.
 */
export function Fill({ children, ...rest }: { children?: ReactNode; [attr: string]: unknown }) {
  return <div class="fill" {...rest}>{children}</div>;
}

/** Wait `ms` milliseconds. */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait for `n` animation frames. */
export async function frames(n = 2): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => requestAnimationFrame(r));
  }
}
