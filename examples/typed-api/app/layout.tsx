import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "denext · typed API, end to end",
  description: "defineApi + useApi + batching, defineSubscription, createChannel — no tRPC.",
  head: `<link rel="stylesheet" href="/styles.css">`,
};

const SURFACE = ["defineApi", "useApi", "defineSubscription", "createChannel"];

export default function RootLayout({ children }: LayoutProps) {
  return (
    <div class="shell">
      <nav>
        <strong>denext · typed api</strong>
        {SURFACE.map((name) => <span key={name}>{name}</span>)}
      </nav>
      {children}
      <footer class="foot-note">
        Source: <code>examples/typed-api</code> · every wire is exercised by{" "}
        <code>tests/integration/example-typed-api.test.ts</code>.
      </footer>
    </div>
  );
}
