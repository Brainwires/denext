import { Code } from "../components/ui.tsx";
import { DOCS_VERSION, SITE_ORIGIN } from "./layout.tsx";

/** schema.org structured data for the site + the framework (rich-result eligibility). */
const JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${SITE_ORIGIN}/#website`,
      "name": "denext",
      "url": `${SITE_ORIGIN}/`,
      "description":
        "Documentation for denext, the lightweight Deno framework that ships one codebase to the web, iOS, Android and the desktop.",
    },
    {
      "@type": "SoftwareApplication",
      "name": "denext",
      "applicationCategory": "DeveloperApplication",
      "operatingSystem": "Deno",
      "url": `${SITE_ORIGIN}/`,
      "softwareVersion": DOCS_VERSION,
      "description":
        "Write your app once and ship it to the web, iOS, Android, macOS, Windows and Linux. denext unifies the accepted web-framework features behind the React and App Router APIs you already know, so existing packages work as-is, on its own small React core and a zero-npm runtime.",
      "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
      "author": {
        "@type": "Organization",
        "name": "Brainwires",
        "url": "https://github.com/Brainwires/denext",
      },
    },
  ],
});

const SAMPLE = `// app/copy-link.tsx — one component for the web, the phone and the desktop
"use client";
import { useState } from "denext";
import { runtimePlatform, writeClipboard } from "denext/mobile";

export function CopyLink() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    // Capacitor on iOS/Android, the OS clipboard on desktop, navigator.clipboard on the web
    await writeClipboard(location.href);
    setCopied(true);
  };
  return (
    <button type="button" onClick={copy}>
      {copied ? "Copied" : \`Copy link (\${runtimePlatform()})\`}
    </button>
  );
}`;

interface Card {
  title: string;
  body: string;
  link?: { href: string; label: string };
}

interface Pillar {
  id: string;
  title: string;
  intro: string;
  cards: Card[];
  link: { href: string; label: string };
}

const PILLARS: Pillar[] = [
  {
    id: "everywhere",
    title: "Write it once, ship it everywhere",
    intro:
      "One codebase, one component model, one router and one typed API layer. The same files build the web app, the phone app and the desktop app.",
    cards: [
      {
        title: "The web",
        body:
          "Server rendering with streaming, a static export for any host or CDN, or a client-only SPA, chosen per app and per route. deno task dev / build / start / export.",
      },
      {
        title: "iOS and Android",
        body:
          "The export runs in a Capacitor shell, and denext/mobile reaches the device with no @capacitor/* import: safe areas, haptics, files, the camera, biometrics, push, deep links, widgets, Live Activities and more.",
      },
      {
        title: "macOS, Windows and Linux",
        body:
          "denext desktop wraps the app in a native window on Deno Desktop at Electron parity: menus, tray, notifications, dialogs, deep links, global shortcuts and signed self-updates, packaged least-privilege. It runs on denext's own Deno Desktop runtime, built in the open from public forks, verified by SHA-256 and upstream-first.",
        link: {
          href: "/docs/desktop-runtime",
          label: "What our Deno Desktop runtime ships, and why →",
        },
      },
      {
        title: "One API across platforms",
        body:
          "The same denext/mobile call reaches Capacitor on a phone, the native runtime in a desktop window and a web fallback in a browser. Components don't need to know where they run.",
      },
    ],
    link: { href: "/docs/deployment-targets", label: "Deployment targets →" },
  },
  {
    id: "unified",
    title: "Every accepted web-framework feature, in one framework",
    intro:
      "The features you'd otherwise assemble from several frameworks and libraries, built in and designed together, behind the conventions developers already know.",
    cards: [
      {
        title: "App Router, Server Components and Actions",
        body:
          "layout/page/loading/error, streaming Suspense, parallel and intercepting routes, middleware, metadata, images, fonts and i18n, plus progressive-enhancement Server Actions that work with JavaScript disabled.",
      },
      {
        title: "Every rendering strategy",
        body:
          "SSR, static export, Partial Prerendering with Cache Components, Astro-style islands with six hydration directives, and Qwik-style resumability on React's own useState/onClick API.",
      },
      {
        title: "Typed end to end",
        body:
          "defineApi and defineAction take Standard Schemas (Zod, Valibot, ArkType, TypeBox); createApiClient and useApi type every call. The same definitions serve OpenAPI 3.1 and GraphQL.",
      },
      {
        title: "Live data",
        body:
          "Live Server Components push a re-rendered boundary over a WebSocket when a cache tag changes; defineSubscription and createChannel give typed, authorized server push.",
      },
      {
        title: "Auth, data and jobs",
        body:
          "denextAuth with OAuth presets, passwords, magic links, TOTP and roles; Deno's built-in SQLite, KV, Postgres, Drizzle and Prisma; use cache; cron tasks; typed content collections.",
      },
      {
        title: "Secure by default",
        body:
          "A strict hash-based Content-Security-Policy, CSRF-defended Server Actions, signed httpOnly cookies, SSRF-safe image optimization and fetch, and Deno's permission sandbox.",
      },
    ],
    link: { href: "/docs/features", label: "Every feature →" },
  },
  {
    id: "ecosystem",
    title: "Your existing packages work as-is",
    intro:
      "denext is surface compatible with the React, Next.js, Remix, React Native and Expo APIs, so the ecosystem you already use comes with you. There's no new ecosystem to wait for.",
    cards: [
      {
        title: "npm and JSR libraries",
        body:
          "npm: and jsr: imports work as usual. Component and app libraries like Radix, Base UI, shadcn/ui, TanStack Router, recharts, react-hook-form, lucide and next-intl run on denext's core.",
      },
      {
        title: "Proven on real apps",
        body:
          "Real codebases run on denext: the shadcn/ui site, the Next.js App Router playground, the Epic Stack (Remix) and T3 Code's web and desktop app. The playground and the Epic Stack are re-migrated nightly in CI.",
      },
      {
        title: "Bring your app in one pass",
        body:
          "denext migrate converts a Next.js (App or Pages Router), Remix / React Router, Expo or Vite app and keeps your source intact: a deno.json alias map resolves react and next/* to denext.",
      },
      {
        title: "React Native and Expo code",
        body:
          "reactNative: true builds an Expo or React Native app's own source for the web and the shells, with expo-router, React Navigation, FlatList and Reanimated mapped onto denext.",
      },
    ],
    link: { href: "/docs/npm-react-libraries", label: "Using npm React libraries →" },
  },
  {
    id: "lightweight",
    title: "Lightweight by design",
    intro:
      "denext brings its own small React 19-compatible core instead of React + ReactDOM + a framework runtime, so it does more and still ships less. Measured on examples/hello against Next.js 16.3 + React 19.2 (bench/REPORT.md):",
    cards: [
      {
        title: "19.6 KB shared runtime",
        body:
          "About 7× less JavaScript than the same app on Next.js (136.9 KB), and each later navigation costs about 1 KB. On a library-heavy app (recharts, react-hook-form, Radix) routes ship 1.8–4.9× less.",
      },
      {
        title: "0 KB on a static page",
        body:
          'A page with no interactivity ships pure server-rendered HTML, with no hydration bundle. Add "use client" only where you need it, or an island that loads on idle, visible or interaction.',
      },
      {
        title: "Fast where it counts",
        body:
          "SSR throughput is on par or faster (2–4× on the benchmark's page and markup workloads), and time to interactive is on par or slightly faster.",
      },
      {
        title: "Zero runtime npm",
        body:
          "Nothing the framework ships at runtime pulls from npm, and CI enforces it. Web standards all the way down: Request, Response, fetch, crypto.subtle. No node_modules, one deno.json.",
      },
    ],
    link: { href: "/docs/architecture", label: "How it's built →" },
  },
];

export default function Landing() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON_LD }}
      />
      <section class="hero">
        <span class="badge">This page ships 0 KB of JavaScript</span>
        <h1>
          Write it once.<br />Ship it <span class="accent">everywhere</span>.
        </h1>
        <p class="tagline">
          denext is a complete, lightweight application framework for Deno. One codebase becomes a
          web app, an iOS and Android app, and a desktop app for macOS, Windows and Linux. Every
          accepted web-framework feature lives in one unified framework, surface compatible with the
          React and App Router APIs you already know, so your existing packages work as-is. And it
          runs on its own small React core with a zero-npm runtime.
        </p>
        <div class="cta">
          <a class="btn primary" href="/docs/getting-started">Get started</a>
          <a class="btn" href="/docs/tutorial">Follow the tutorial</a>
          <a class="btn" href="/docs/migrating">Bring your existing app</a>
          <a class="btn" href="/docs/desktop">Desktop</a>
          <a class="btn" href="/docs/mobile">Mobile</a>
        </div>
        <Code lang="tsx">{SAMPLE}</Code>
      </section>

      {PILLARS.map((p) => (
        <section key={p.id} id={p.id} class="pillar">
          <div class="pillar-head">
            <h2>{p.title}</h2>
            <p>{p.intro}</p>
          </div>
          <div class="features">
            {p.cards.map((f) => (
              <div key={f.title} class="feature">
                <h3>{f.title}</h3>
                <p>{f.body}</p>
                {f.link && (
                  <p class="feature-link">
                    <a href={f.link.href}>{f.link.label}</a>
                  </p>
                )}
              </div>
            ))}
          </div>
          <p class="pillar-link">
            <a href={p.link.href}>{p.link.label}</a>
          </p>
        </section>
      ))}

      <section class="closing">
        <h2>You're standing in it</h2>
        <p>
          This docs site is a denext app, static-exported. Every page you read here is pure HTML —
          view source and you'll find no framework runtime, because these pages have no
          interactivity to hydrate. That's the default, not a mode you opt into.
        </p>
        <a class="btn primary" href="/docs/getting-started">Start building →</a>
      </section>
    </>
  );
}
