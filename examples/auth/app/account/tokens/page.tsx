import { type ApiTokenRecord, auth, listApiTokens, type PageProps } from "denext/server";
import { authConfig } from "../../../lib/auth-config.ts";
import { onceKey, takeOnce } from "../../../lib/once.ts";
import { createToken, revokeToken } from "./actions.ts";

const ERRORS: Record<string, string> = {
  unknown: "That token is already gone.",
};

/** An epoch-seconds field as a date, or a dash. */
function when(seconds: number | undefined): string {
  return seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : "—";
}

/** One row of the list, with its revoke form. Records never carry the plaintext. */
function TokenLine({ token }: { token: ApiTokenRecord }) {
  return (
    <tr>
      <td>{token.name || "untitled"}</td>
      <td>{(token.scopes ?? []).join(", ") || "—"}</td>
      <td>{when(token.createdAt)}</td>
      <td>{when(token.expiresAt)}</td>
      <td>{when(token.lastUsedAt)}</td>
      <td>
        <form action={revokeToken} method="post">
          <input type="hidden" name="tokenId" value={token.id} />
          <button type="submit" class="danger">Revoke</button>
        </form>
      </td>
    </tr>
  );
}

/** The plaintext, rendered the only time it will ever exist. */
function NewToken({ token }: { token: string }) {
  return (
    <div class="ok">
      <p>
        Copy this now — it is stored only as a SHA-256 hash and will never be shown again:
      </p>
      <p>
        <code class="token">{token}</code>
      </p>
      <p class="hint">
        Use it as <code>curl -H "Authorization: Bearer …" http://localhost:3000/api/me</code>.
      </p>
    </div>
  );
}

/** The message for an `?error=` code, or `""` when there is nothing to explain. */
function errorMessage(params: PageProps["searchParams"]): string {
  return ERRORS[String(params.error ?? "")] ?? "";
}

/** The outcome of the last action, plus the plaintext when one was just minted. */
function Notices({ params, created }: { params: PageProps["searchParams"]; created?: string }) {
  const error = errorMessage(params);
  return (
    <>
      {error && <p class="err">{error}</p>}
      {params.revoked === "1" && <p class="ok">Token revoked — it stopped working at once.</p>}
      {created && <NewToken token={created} />}
    </>
  );
}

/** The caller's live tokens. Revoked and expired ones are already gone from the list. */
function TokenTable({ tokens }: { tokens: ApiTokenRecord[] }) {
  if (tokens.length === 0) return <p class="hint">No tokens yet.</p>;
  return (
    <table class="grid">
      <thead>
        <tr>
          <th>Label</th>
          <th>Scopes</th>
          <th>Created</th>
          <th>Expires</th>
          <th>Last used</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {tokens.map((token) => <TokenLine token={token} key={token.id} />)}
      </tbody>
    </table>
  );
}

// Gated by middleware.ts (requireAuth) — a signed-out request never reaches this page.
export default async function Tokens({ searchParams }: PageProps) {
  const session = await auth();
  if (!session) return null;
  const tokens = await listApiTokens(authConfig, session.user.id);
  // Single-use: a reload shows the list, never the secret again.
  const created = searchParams.created === "1" ? takeOnce(onceKey(session)) : undefined;
  return (
    <section class="stack">
      <h1>API tokens</h1>
      <p>
        A bearer token authenticates a script the way your cookie authenticates this browser. It is
        {" "}
        <code>tok_</code>{" "}
        plus 256 bits of entropy; only its hash is stored, it never sets a cookie, and it is never
        accepted on the <code>/auth/*</code> endpoints — so a leaked token cannot mint another one.
      </p>
      <Notices params={searchParams} created={created} />

      <h2>Create a token</h2>
      <form action={createToken} method="post" class="stack">
        <label>
          Label
          <input name="label" type="text" placeholder="ci" />
        </label>
        <button type="submit">Create token</button>
      </form>

      <h2>Your tokens</h2>
      <TokenTable tokens={tokens} />
    </section>
  );
}
