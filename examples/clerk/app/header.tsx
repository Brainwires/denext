import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import { Nav } from "./account-panel.tsx";

/** The top bar: navigation, and Clerk's sign-in / account buttons. */
export function Header() {
  return (
    <header class="bar">
      <Nav />
      <Show when="signed-out">
        <SignInButton mode="modal" />
        <SignUpButton mode="modal" />
      </Show>
      <Show when="signed-in">
        <UserButton />
      </Show>
    </header>
  );
}
