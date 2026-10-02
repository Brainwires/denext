import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";

/** The top bar: navigation, and Clerk's sign-in / account buttons. */
export function Header() {
  return (
    <header class="bar">
      <nav>
        <a href="/">Home</a>
        <a href="/protected">Protected page</a>
      </nav>
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
