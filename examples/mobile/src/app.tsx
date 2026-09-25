// The app shell: two routes (`/` and `/detail/:id`), the platform at the top, and the
// listeners that must subscribe early (deep links, push, quick actions, shares), since the
// event that cold-started the app is handed to the listeners present at startup.
import { useState } from "denext";
import {
  type DeepLinkEvent,
  type PushNotification,
  type PushTap,
  runtimePlatform,
  type SharedContent,
  useDeepLink,
  usePushReceived,
  usePushTapped,
  useQuickAction,
  useShareReceived,
} from "denext/mobile";
import { Basics } from "./sections/basics.tsx";
import { Files } from "./sections/files.tsx";
import { Inbound } from "./sections/inbound.tsx";
import { IosExtras } from "./sections/ios-extras.tsx";
import { Ota } from "./sections/ota.tsx";
import { navigate, usePathname } from "./ui.tsx";

/** The last thing each inbound channel delivered. */
export interface Inbox {
  deepLink?: DeepLinkEvent;
  pushReceived?: PushNotification;
  pushTapped?: PushTap;
  quickAction?: string;
  shared?: SharedContent;
}

function useInbox(): Inbox {
  const [inbox, setInbox] = useState<Inbox>({});
  const put = (patch: Inbox) => setInbox((prev) => ({ ...prev, ...patch }));
  // A link like denextmobile://detail/42 opens /detail/42: the default `route: true`
  // pushes the path and fires popstate, which usePathname follows.
  useDeepLink((deepLink) => put({ deepLink }));
  usePushReceived((pushReceived) => put({ pushReceived }));
  // A tapped notification whose data has `path: "/detail/7"` navigates there the same way.
  usePushTapped((pushTapped) => put({ pushTapped }));
  useQuickAction((quickAction) => {
    put({ quickAction });
    if (quickAction.startsWith("detail-")) {
      navigate(`/detail/${quickAction.slice(7)}`);
    }
  });
  useShareReceived((shared) => put({ shared }));
  return inbox;
}

function Detail({ id }: { id: string }) {
  return (
    <section class="card">
      <h2>Detail {id}</h2>
      <p>
        You reached <code>/detail/{id}</code>. Deep links (<code>
          denextmobile://detail/{id}
        </code>), push taps (<code>data.path</code>) and quick actions route here.
      </p>
      <button type="button" onClick={() => navigate("/")}>
        Back to the kitchen sink
      </button>
    </section>
  );
}

export function App() {
  const path = usePathname();
  const inbox = useInbox();
  const detail = /^\/detail\/([^/]+)$/.exec(path);
  return (
    <main>
      <header>
        <h1>denext mobile</h1>
        <p>
          runtimePlatform(): <strong>{runtimePlatform()}</strong> · route: <code>{path}</code>
        </p>
      </header>
      {detail ? <Detail id={decodeURIComponent(detail[1])} /> : (
        <>
          <Basics />
          <Files />
          <Inbound inbox={inbox} />
          <IosExtras />
          <Ota />
        </>
      )}
    </main>
  );
}
