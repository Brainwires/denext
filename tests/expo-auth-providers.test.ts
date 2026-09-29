// denext/expo/auth-session's request classes and hooks, and the Google / Facebook presets
// (expo-auth-session/providers/*): client-id choice per platform, PKCE and the code exchange in
// the Capacitor shell, the implicit / ID-token flows on the web. The auth-session plugin and
// the token endpoint are faked.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { flushSync } from "../src/client/reconciler.ts";
import * as AuthSession from "../src/expo/auth-session.ts";
import * as Google from "../src/expo/auth-session-google.ts";
import * as Facebook from "../src/expo/auth-session-facebook.ts";
import { reloadApplicationInfoForTesting } from "../src/expo/application.ts";
import { providerClientId } from "../src/expo/internal/auth-providers.ts";
import { type Any, fakePlugin, inShell, mount, withGlobals } from "./helpers/mobile-fakes.ts";

/** Let promise callbacks and timers run, then commit what they scheduled. */
async function tick(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

/** A fetch that records each request and answers with `reply(url, init)` as JSON. */
function fakeFetch(reply: (url: string, init: RequestInit) => [number, unknown]) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (url: string, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    const [status, body] = reply(String(url), init);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { requests, fetch };
}

/** A request's form body as an object. */
const form = (init: RequestInit) => Object.fromEntries(new URLSearchParams(String(init.body)));

const TOKEN_ENDPOINT = { tokenEndpoint: "https://auth.test/token" };

// ---- the request classes -----------------------------------------------------------------------

Deno.test("expo-auth-session: AccessTokenRequest sends Basic credentials and parses tokens", async () => {
  const net = fakeFetch(() => [200, { access_token: "at", id_token: "it", expires_in: 60 }]);
  await withGlobals({ fetch: net.fetch }, async () => {
    const request = new AuthSession.AccessTokenRequest({
      clientId: "app",
      clientSecret: "s3cret",
      code: "c1",
      redirectUri: "myapp://cb",
      scopes: ["openid"],
      extraParams: { code_verifier: "v" },
    });
    const token = await request.performAsync(TOKEN_ENDPOINT);
    assertEquals([token.accessToken, token.idToken, token.expiresIn], ["at", "it", 60]);
    assertEquals((token.rawResponse as Any).access_token, "at");
    assert(!("rawResponse" in token.getRequestConfig()));
    const { init } = net.requests[0];
    assertEquals((init.headers as Any).Authorization, `Basic ${btoa("app:s3cret")}`);
    assertEquals(form(init), {
      grant_type: "authorization_code",
      scope: "openid",
      code_verifier: "v",
      redirect_uri: "myapp://cb",
      code: "c1",
    });
    assertEquals(request.getRequestConfig().grantType, AuthSession.GrantType.AuthorizationCode);
    // Without a secret the client id rides in the body.
    await AuthSession.exchangeCodeAsync(
      { clientId: "pub", code: "c2", redirectUri: "myapp://cb" },
      TOKEN_ENDPOINT,
    );
    assertEquals(form(net.requests[1].init).client_id, "pub");
    assertEquals((net.requests[1].init.headers as Any).Authorization, undefined);
  });
  assertThrows(
    () => new AuthSession.AccessTokenRequest({ clientId: "a", code: "", redirectUri: "x://" }),
    Error,
    "code",
  );
});

Deno.test("expo-auth-session: token errors, refresh, revoke and requestAsync", async () => {
  const net = fakeFetch((url, init) => {
    if (url.endsWith("/revoke")) return [200, {}];
    if (url.includes("/userinfo")) return [200, { sub: "u" }];
    return form(init).refresh_token === "bad"
      ? [400, { error: "invalid_grant", error_description: "expired" }]
      : [200, { access_token: "fresh" }];
  });
  await withGlobals({ fetch: net.fetch }, async () => {
    const err = await AuthSession.refreshAsync(
      { clientId: "a", refreshToken: "bad" },
      TOKEN_ENDPOINT,
    )
      .catch((e) => e);
    assert(err instanceof AuthSession.TokenError && err instanceof AuthSession.ResponseError);
    assertEquals([err.code, err.description], ["invalid_grant", "expired"]);
    const fresh = await AuthSession.refreshAsync(
      { clientId: "a", refreshToken: "good" },
      TOKEN_ENDPOINT,
    );
    assertEquals(fresh.accessToken, "fresh");
    assertEquals(form(net.requests[1].init).grant_type, "refresh_token");
    assert(
      await AuthSession.revokeAsync(
        { clientId: "a", token: "t", tokenTypeHint: AuthSession.TokenTypeHint.AccessToken },
        { revocationEndpoint: "https://auth.test/revoke" },
      ),
    );
    assertEquals(form(net.requests[2].init), {
      token: "t",
      token_type_hint: "access_token",
      client_id: "a",
    });
    const info = await AuthSession.requestAsync<{ sub: string }>("https://auth.test/userinfo", {
      method: "GET",
      body: { a: "1" },
      dataType: "json",
    });
    assertEquals(info.sub, "u");
    assertEquals(net.requests[3].url, "https://auth.test/userinfo?a=1");
  });
  assertThrows(() => new AuthSession.RefreshTokenRequest({ clientId: "a" }), Error, "refreshToken");
  assertEquals(new AuthSession.AuthError({ error: "access_denied", state: "s" }).state, "s");
  await assertRejects(
    () => new AuthSession.Request({}).performAsync({}),
    Error,
    "must be extended",
  );
});

Deno.test("expo-auth-session: useLoadedAuthRequest + useAuthRequestResult prompt in the shell", async () => {
  const discovery = { authorizationEndpoint: "https://auth.test/authorize" };
  let request: AuthSession.AuthRequest | null = null;
  let prompt!: AuthSession.PromptMethod;
  let result: AuthSession.AuthSessionResult | null = null;
  const session = fakePlugin(["start"]);
  await inShell("ios", { DenextAuthSession: session.plugin }, async () => {
    const { root } = mount(() => {
      request = AuthSession.useLoadedAuthRequest(
        { clientId: "app", redirectUri: "myapp://cb", scopes: ["openid"] },
        discovery,
        AuthSession.AuthRequest,
      );
      [result, prompt] = AuthSession.useAuthRequestResult(request, discovery, {
        windowFeatures: { width: 10 },
      });
      return null;
    });
    await tick();
    const loaded = request as AuthSession.AuthRequest | null;
    assert(loaded?.url?.startsWith("https://auth.test/authorize?"));
    session.plugin.start = () =>
      Promise.resolve({ url: `myapp://cb?code=abc&state=${loaded!.state}` });
    const out = await prompt();
    await tick();
    assertEquals(out.type === "success" && out.params.code, "abc");
    assertEquals((result as AuthSession.AuthSessionResult | null)?.type, "success");
    root.unmount();
  });
});

// ---- providers ------------------------------------------------------------------------------------

Deno.test("providers: the client id follows the platform the page runs on", async () => {
  const ids = { clientId: "any", webClientId: "web", iosClientId: "ios", androidClientId: "and" };
  assertEquals(providerClientId(ids, "Google"), "web");
  await inShell("ios", {}, () => assertEquals(providerClientId(ids, "Google"), "ios"));
  await inShell("android", {}, () => assertEquals(providerClientId(ids, "Google"), "and"));
  assertEquals(providerClientId({ clientId: "any" }, "Google"), "any");
  assertThrows(() => providerClientId({}, "Google"), Error, "`webClientId` must be defined");
});

Deno.test("providers/google: in the iOS shell the code flow runs and the code is exchanged", async () => {
  const net = fakeFetch(() => [200, { access_token: "g-at", id_token: "g-it" }]);
  const session = fakePlugin(["start"]);
  const config = { ios: { bundleIdentifier: "dev.app" } };
  await inShell("ios", { DenextAuthSession: session.plugin }, async () => {
    await reloadApplicationInfoForTesting();
    let hook!: Google.GoogleAuthRequestHook;
    const { root } = mount(() => {
      hook = Google.useAuthRequest({ iosClientId: "ios-id", webClientId: "web-id" });
      return null;
    });
    await tick();
    const [request] = hook;
    const url = new URL(request!.url!);
    assertEquals(url.searchParams.get("client_id"), "ios-id");
    assertEquals(url.searchParams.get("response_type"), "code");
    assertEquals(url.searchParams.get("redirect_uri"), "dev.app:/oauthredirect");
    assertEquals(url.searchParams.get("code_challenge_method"), "S256");
    assert(url.searchParams.get("scope")!.includes("userinfo.email"));
    session.plugin.start = (arg?: unknown) => {
      assertEquals((arg as Any).callbackScheme, "dev.app");
      return Promise.resolve({ url: `dev.app:/oauthredirect?code=G1&state=${request!.state}` });
    };
    await hook[2]();
    await tick();
    const [, response] = hook;
    assertEquals(response?.type, "success");
    if (response?.type === "success") {
      assertEquals([response.params.id_token, response.params.access_token], ["g-it", "g-at"]);
      assertEquals(response.authentication?.accessToken, "g-at");
    }
    const body = form(net.requests[0].init);
    assertEquals([body.code, body.client_id], ["G1", "ios-id"]);
    assertEquals(body.code_verifier, request!.codeVerifier);
    root.unmount();
  }, { __DENEXT_EXPO_CONFIG__: config, fetch: net.fetch });
  await reloadApplicationInfoForTesting();
});

Deno.test("providers/google: a failed exchange is an error response", async () => {
  const net = fakeFetch(() => [400, { error: "invalid_client" }]);
  const session = fakePlugin(["start"]);
  await inShell("android", { DenextAuthSession: session.plugin }, async () => {
    let hook!: Google.GoogleAuthRequestHook;
    const { root } = mount(() => {
      hook = Google.useAuthRequest({ androidClientId: "and-id", redirectUri: "app:/cb" });
      return null;
    });
    await tick();
    session.plugin.start = () => Promise.resolve({ url: `app:/cb?code=X&state=${hook[0]!.state}` });
    await hook[2]();
    await tick();
    const response = hook[1];
    assertEquals(response?.type, "error");
    if (response?.type === "error") assertEquals(response.errorCode, "invalid_client");
    root.unmount();
  }, { fetch: net.fetch });
});

Deno.test("providers/google + facebook: the web flows ask for tokens directly", async () => {
  await withGlobals({ location: { origin: "https://app.test" } }, async () => {
    let google!: Google.GoogleAuthRequestHook;
    let facebook!: ReturnType<typeof Facebook.useAuthRequest>;
    const { root } = mount(() => {
      google = Google.useIdTokenAuthRequest({ webClientId: "web-id", loginHint: "a@b.c" });
      facebook = Facebook.useAuthRequest({ clientId: "123", language: "it_IT" });
      return null;
    });
    await tick();
    const g = new URL(google[0]!.url!);
    assertEquals(g.searchParams.get("response_type"), "id_token");
    assertEquals(g.searchParams.get("client_id"), "web-id");
    assertEquals(g.searchParams.get("login_hint"), "a@b.c");
    assert(/^[0-9a-f]{32}$/.test(g.searchParams.get("nonce")!), "an ID-token nonce");
    assertEquals(g.searchParams.get("code_challenge"), null, "no PKCE in the implicit flow");
    assertEquals(g.searchParams.get("redirect_uri"), "https://app.test/");
    const f = new URL(facebook[0]!.url!);
    assertEquals(f.origin + f.pathname, Facebook.discovery.authorizationEndpoint);
    assertEquals(f.searchParams.get("response_type"), "token");
    assertEquals(f.searchParams.get("display"), "popup");
    assertEquals(f.searchParams.get("locale"), "it_IT");
    assertEquals(f.searchParams.get("scope"), "public_profile email");
    assert(f.searchParams.get("auth_nonce"));
    root.unmount();
  });
  await inShell("android", {}, async () => {
    let facebook!: ReturnType<typeof Facebook.useAuthRequest>;
    const { root } = mount(() => {
      facebook = Facebook.useAuthRequest({ androidClientId: "987" });
      return null;
    });
    await tick();
    assertEquals(new URL(facebook[0]!.url!).searchParams.get("redirect_uri"), "fb987://authorize");
    root.unmount();
  });
  assertEquals(Google.discovery.tokenEndpoint, "https://oauth2.googleapis.com/token");
});
