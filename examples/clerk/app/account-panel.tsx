"use client";
// The signed-in state and a call to the protected API. The request carries the session token
// as `Authorization: Bearer …` (from `getToken()`), which is what the desktop and mobile shells
// need (they have no cookie on the server's origin); on the web the cookie would do too.
import { useAuth, useUser } from "@clerk/nextjs";
import { useState } from "react";
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
