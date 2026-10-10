import { DocsShell } from "../../../components/ui.tsx";
import reference from "./reference.json" with { type: "json" };

/** A module name → a URL-safe single segment (`denext/server` → `denext-server`). */
const slug = (m: string) => m.replace(/\//g, "-");
const total = reference.groups.reduce((n, g) => n + g.symbols.length, 0);

/** One-line blurb per stable entry point (a new module without one just shows its count). */
const BLURB: Record<string, string> = {
  "denext": "The main entrypoint — JSX runtime, hooks, components, client navigation, SSR.",
  "denext/server":
    "createApp / serve, middleware, caching, Server Actions, cookies & sessions, image optimization.",
  "denext/client": "The browser reconciler + hydration, client hooks, and soft navigation.",
  "denext/devtools": "The glass-box DevTools inspector API.",
  "denext/testing": "In-process app & component testing (no browser) + route conformance probing.",
  "denext/live": "Live Server Components — server-pushed boundary updates.",
  "denext/lazy": "Lazy / deferred module + island hydration helpers.",
  "denext/desktop": "Desktop packaging runtime.",
  "denext/desktop/updater": "Signed over-the-air UI updates for a Deno Desktop app.",
  "denext/mobile": "Client runtime for apps in a Capacitor iOS/Android shell.",
  "denext/updates":
    "checkForUpdates / applyUpdates: one update API for phones, Deno Desktop and the web.",
  "denext/navigation": "Native-feel StackLayout, TabsLayout and Sheet for app-like navigation.",
  "denext/virtual-masonry": "VirtualMasonry: a virtualized masonry (Pinterest-style) grid.",
  "denext/feature": "feature(): compile-time feature flags, folded and dead-code eliminated.",
  "denext/jsx-directives": "ClientDirectives: the client:* props, for apps typed by @types/react.",
  "denext/cli/command": "The CLI command contract (for plugins contributing verbs).",
};

/** The `denext/expo/*` shims get their own section, after the core entry points. */
const isExpo = (m: string) => m.startsWith("denext/expo/");
const core = reference.groups.filter((g) => !isExpo(g.module));
const expo = reference.groups.filter((g) => isExpo(g.module));

/** One module card: its name, symbol count and (when it has one) blurb. */
function ModuleCard({ g }: { g: { module: string; symbols: unknown[] } }) {
  return (
    <a class="api-card" href={`/docs/api/${slug(g.module)}`}>
      <span class="api-card-head">
        <code>{g.module}</code>
        <span class="api-card-count">{g.symbols.length}</span>
      </span>
      {BLURB[g.module] ? <span class="api-card-blurb">{BLURB[g.module]}</span> : null}
    </a>
  );
}

export const metadata = {
  title: "API reference",
  description:
    "Every public export of denext, browseable by entry point — auto-generated from the source with deno doc.",
};

export default function ApiIndex() {
  return (
    <DocsShell
      active="api"
      title="API reference"
      lead="Every public export of denext, generated straight from the source with deno doc so it never drifts. Browse by entry point."
    >
      <p>
        {total} symbols across {reference.groups.length} entry points. Regenerate with{" "}
        <code>deno task docs:api</code>.
      </p>
      <div class="api-index">
        {core.map((g) => <ModuleCard key={g.module} g={g} />)}
      </div>
      <h2 id="expo-shims">Expo shims</h2>
      <p>
        In <a href="/docs/react-native">React Native mode</a> each <code>expo-*</code>{" "}
        import resolves to one of these modules. They implement the Expo API with web platform APIs
        and, for native capabilities, over{" "}
        <a href="/docs/api/denext-mobile">
          <code>denext/mobile</code>
        </a>. Each module mirrors its Expo package, so read Expo&apos;s documentation for the
        behaviour and these pages for what the shim provides; what each one omits is listed in{" "}
        <a href="/docs/api/denext-expo-manifest">
          <code>denext/expo/manifest</code>
        </a>.
      </p>
      <div class="api-index">
        {expo.map((g) => <ModuleCard key={g.module} g={g} />)}
      </div>
    </DocsShell>
  );
}
