"use client";
// The page side of the desktop e2e (e2e/desktop-test.ts). Inert everywhere else: off desktop it
// does nothing, and in a normal desktop build the `clerkE2e` extension is not enabled, so the
// first call answers `unavailable` and it stops.
//
// sign-in: wait for clerk-js (native mode, through the bridge), sign in with the `+clerk_test`
//   address and the code 424242, call the protected API with the session token, report.
// relaunch: the client JWT survived in the keychain — report who clerk-js restored, call the API
//   again, sign out (clearing the keychain), report.
import { useEffect } from "react";
import { runtimePlatform } from "denext/mobile";
import { desktopExtension } from "denext/desktop/client";
import { quitApp } from "denext/desktop/window";

interface Plan {
  readonly phase: "sign-in" | "relaunch";
  readonly email: string;
  readonly testingToken: string;
}

interface E2E {
  plan(): Promise<Plan | null>;
  log(args: { line: string }): Promise<unknown>;
  report(report: Record<string, unknown>): Promise<unknown>;
}

// deno-lint-ignore no-explicit-any
type ClerkJs = any;

/** clerk-js, once loaded. */
async function loadedClerk(): Promise<ClerkJs> {
  for (let i = 0; i < 600; i++) {
    const c = (globalThis as { Clerk?: ClerkJs }).Clerk;
    if (c?.loaded) return c;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("clerk-js did not load within 60 s");
}

/** `GET /api/me` with the session token, as the account panel calls it. */
async function callApi(clerk: ClerkJs): Promise<{ status: number; body: string }> {
  const token = await clerk.session?.getToken();
  const res = await fetch("/api/me", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.text() };
}

/** Email code sign-in through clerk-js's sign-in resource. */
async function signIn(clerk: ClerkJs, email: string): Promise<void> {
  const si = await clerk.client.signIn.create({ identifier: email });
  const factor = si.supportedFirstFactors.find((f: { strategy: string }) =>
    f.strategy === "email_code"
  );
  await si.prepareFirstFactor({ strategy: "email_code", emailAddressId: factor.emailAddressId });
  const done = await si.attemptFirstFactor({ strategy: "email_code", code: "424242" });
  await clerk.setActive({ session: done.createdSessionId });
}

/** Run one phase of the plan. */
async function run(plan: Plan, log: (line: string) => void): Promise<Record<string, unknown>> {
  const clerk = await loadedClerk();
  log(`clerk-js loaded (user: ${clerk.user?.id ?? "none"})`);
  clerk.__internal_onBeforeRequest((req: { url?: URL }) => {
    req.url?.searchParams.set("__clerk_testing_token", plan.testingToken);
  });
  const bridge = (globalThis as {
    __clerk_internal_electron?: { tokenCache: { getToken(k: string): Promise<string | null> } };
  })
    .__clerk_internal_electron;
  if (plan.phase === "sign-in") {
    if (clerk.user) await clerk.signOut(); // a session left by an earlier run
    await signIn(clerk, plan.email);
    return {
      userId: clerk.user?.id ?? null,
      api: await callApi(clerk),
      savedClientJwt: !!(await bridge?.tokenCache.getToken("__clerk_client_jwt")),
      origin: location.origin,
    };
  }
  const restored = clerk.user?.id ?? null;
  const api = await callApi(clerk);
  await clerk.signOut();
  return {
    userId: restored,
    api,
    signedOut: !clerk.user,
    clientJwtAfterSignOut: await bridge?.tokenCache.getToken("__clerk_client_jwt") ?? null,
  };
}

/** Drive the plan, if this launch has one. */
async function drive(): Promise<void> {
  const e2e = desktopExtension("clerkE2e") as unknown as E2E;
  let plan: Plan | null;
  try {
    plan = await e2e.plan();
  } catch {
    return; // not the e2e build
  }
  if (!plan) return;
  const log = (line: string) => void e2e.log({ line: `${plan!.phase}: ${line}` }).catch(() => {});
  log("driver started");
  const report = await run(plan, log).catch((err) => ({ error: String(err?.message ?? err) }));
  await e2e.report({ phase: plan.phase, ...report });
  await quitApp();
}

export function DesktopE2E() {
  useEffect(() => {
    if (runtimePlatform() === "desktop") void drive();
  }, []);
  return null;
}
