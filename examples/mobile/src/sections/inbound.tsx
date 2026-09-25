// Things that come INTO the app: deep links, push notifications, the OAuth callback,
// home-screen quick actions and content shared from other apps. The listeners live in
// app.tsx (they must subscribe at startup); these sections show what they received.
import { useState } from "denext";
import {
  openAuthSession,
  type PushRegistration,
  registerForPush,
  requestPushPermission,
  setQuickActions,
  writeClipboard,
} from "denext/mobile";
import type { Inbox } from "../app.tsx";
import { Button, Output, Section, show, useRun } from "../ui.tsx";

/** What a channel last delivered, or a placeholder. */
function Last({ label, value }: { label: string; value: unknown }) {
  return (
    <>
      <p class="label">{label}</p>
      <pre class="out">{value === undefined ? "nothing yet" : show(value)}</pre>
    </>
  );
}

function DeepLinks({ inbox }: { inbox: Inbox }) {
  return (
    <Section
      title="Deep links"
      note="Open denextmobile://detail/42 from Safari or Notes: the app opens on /detail/42."
    >
      <Last label="Last link (url, path, launch)" value={inbox.deepLink} />
    </Section>
  );
}

function Push({ inbox }: { inbox: Inbox }) {
  const [registration, setRegistration] = useState<PushRegistration | null>(
    null,
  );
  const [out, run] = useRun();
  const register = () =>
    run(async () => {
      const reg = await registerForPush();
      setRegistration(reg);
      return reg;
    });
  return (
    <Section
      title="Push notifications"
      note='APNs on iOS, FCM on Android (needs google-services.json). Send data { "path": "/detail/7" } and a tap opens /detail/7.'
    >
      <div class="row">
        <Button
          label="Request permission"
          onClick={() => run(requestPushPermission)}
        />
        <Button label="Register" onClick={register} />
        {registration && (
          <Button
            label="Copy token"
            onClick={() => run(() => writeClipboard(registration.token).then(() => "token copied"))}
          />
        )}
      </div>
      <Output value={out} />
      <Last label="Last received (foreground)" value={inbox.pushReceived} />
      <Last label="Last tapped" value={inbox.pushTapped} />
    </Section>
  );
}

// A public https page that redirects to the app's callback scheme stands in for a real
// sign-in provider (see the README). A real provider needs PKCE and `state` too.
const REDIRECTOR = `https://httpbin.org/redirect-to?url=${
  encodeURIComponent("denextmobile://auth?code=test")
}`;

function AuthSession() {
  const [out, run] = useRun();
  const signIn = (url: string) =>
    run(async () => {
      const { url: callback } = await openAuthSession(url, {
        callbackScheme: "denextmobile",
      });
      return { callback, code: new URL(callback).searchParams.get("code") };
    });
  return (
    <Section
      title="Auth session"
      note="The first button redirects straight back with ?code=test. The second opens example.com: press Cancel to see code 'cancelled'."
    >
      <div class="row">
        <Button
          label="Sign in (redirects back)"
          onClick={() => signIn(REDIRECTOR)}
        />
        <Button
          label="Open, then cancel"
          onClick={() => signIn("https://example.com/")}
        />
      </div>
      <Output value={out} />
    </Section>
  );
}

function QuickActions({ inbox }: { inbox: Inbox }) {
  const [out, run] = useRun();
  const set = () =>
    setQuickActions([
      {
        id: "detail-1",
        title: "Open detail 1",
        subtitle: "Routes to /detail/1",
        icon: "star",
      },
      { id: "hello", title: "Say hello" },
    ]).then(() => "set: long-press the app icon");
  return (
    <Section
      title="Quick actions"
      note="Home-screen shortcuts. The detail-1 action routes to /detail/1."
    >
      <Button label="Set quick actions" onClick={() => run(set)} />
      <Output value={out} />
      <Last label="Last quick action" value={inbox.quickAction} />
    </Section>
  );
}

function ShareReceive({ inbox }: { inbox: Inbox }) {
  return (
    <Section
      title="Share to this app"
      note='Share a link, text or photo to "denext mobile" from another app.'
    >
      <Last label="Last shared content" value={inbox.shared} />
    </Section>
  );
}

export function Inbound({ inbox }: { inbox: Inbox }) {
  return (
    <>
      <DeepLinks inbox={inbox} />
      <Push inbox={inbox} />
      <AuthSession />
      <QuickActions inbox={inbox} />
      <ShareReceive inbox={inbox} />
    </>
  );
}
