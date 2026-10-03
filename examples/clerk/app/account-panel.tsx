"use client";
// The signed-in state and a call to the protected API. The request carries the session token
// as `Authorization: Bearer …` (from `getToken()`), which is what the desktop and mobile shells
// need (they have no cookie on the server's origin); on the web the cookie would do too.
import { SignInButton, useAuth, useUser } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { apiUrl } from "../lib/api.ts";

/** Who is signed in, or how to sign in. */
function Greeting({ signedIn }: { signedIn: boolean }) {
  const { user } = useUser();
  if (!signedIn) {
    return (
      <p>Signed out. Use “Sign in” above: email code, password, Google / GitHub or a passkey.</p>
    );
  }
  return (
    <p>
      Signed in as <strong id="account-email">{user?.primaryEmailAddress?.emailAddress}</strong>
    </p>
  );
}

/** `GET /api/me` with the session token, and its answer. */
function ApiCall() {
  const { getToken } = useAuth();
  const [result, setResult] = useState("");
  async function callApi() {
    const token = await getToken();
    const res = await fetch(apiUrl("/api/me"), {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    setResult(`${res.status} ${await res.text()}`);
  }
  return (
    <>
      <button type="button" class="primary" id="call-api" onClick={callApi}>
        Call /api/me
      </button>
      {result && <pre id="api-result">{result}</pre>}
    </>
  );
}

export function AccountPanel() {
  const { isLoaded, isSignedIn, signOut } = useAuth();
  if (!isLoaded) return <div class="card muted">Loading Clerk…</div>;
  return (
    <div class="card" id="account" data-signed-in={isSignedIn ? "yes" : "no"}>
      <Greeting signedIn={!!isSignedIn} />
      <p>
        <ApiCall /> {isSignedIn && (
          <button type="button" id="sign-out" onClick={() => signOut()}>
            Sign out
          </button>
        )}
      </p>
    </div>
  );
}

/** The page links. `/protected` works in every build: see app/protected/page.tsx. */
export function Nav() {
  return (
    <nav>
      <a href="/">Home</a>
      <a href="/protected">Protected page</a>
    </nav>
  );
}

/**
 * The protected page's content. It runs in the browser so it exists in the static export the
 * Capacitor shell and the Deno Desktop window load, not only where a server renders pages:
 * signed out, it offers Clerk's sign-in modal (in the app, never a navigation to the hosted page,
 * which a native shell would open in the system browser); signed in, the server verifies the
 * session through `GET /api/me` (bearer token) and the page shows what the server answered.
 */
export function ProtectedContent() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <p>Loading…</p>;
  return isSignedIn ? <SignedInContent /> : <SignInPrompt />;
}

/** Signed out: Clerk's sign-in modal. */
function SignInPrompt() {
  return (
    <div class="card">
      <p>This page needs a signed-in user.</p>
      <SignInButton mode="modal" />
    </div>
  );
}

/** Signed in: the user, and what `GET /api/me` answered for the session token. */
function SignedInContent() {
  const { getToken } = useAuth();
  const { user } = useUser();
  const [me, setMe] = useState("checking…");
  useEffect(() => {
    let live = true;
    (async () => {
      const token = await getToken();
      const res = await fetch(apiUrl("/api/me"), {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      const body = await res.text();
      if (live) setMe(`${res.status} ${body}`);
    })();
    return () => {
      live = false;
    };
  }, []);
  return (
    <div class="card">
      <p>
        Signed in as <strong>{user?.primaryEmailAddress?.emailAddress}</strong>.
      </p>
      <p>
        Verified by the server (<code>GET /api/me</code>): <code id="protected-me">{me}</code>
      </p>
    </div>
  );
}
