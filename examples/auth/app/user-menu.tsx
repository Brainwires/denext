"use client";

// The client-side session surface: `useSession` reads the SessionProvider state (seeded
// from the server, so there's no loading flash) and `signOut` POSTs /auth/signout.

import { signOut, useSession } from "denext";

export function UserMenu() {
  const { user, status } = useSession();
  if (status === "loading") return null;
  if (!user) return <a href="/login">Sign in</a>;
  return (
    <>
      <a href="/dashboard">Dashboard</a>
      <span class="who">{user.email}</span>
      <button
        type="button"
        class="linkbtn"
        onClick={() => signOut({ callbackUrl: "/" })}
      >
        Sign out
      </button>
    </>
  );
}
